// Encrypted on-device vault persistence (Marco 5).
//
// The /net vault's per-device secret share lives only in memory today, so a page reload loses
// the vault. This module persists it in IndexedDB, with the secret bytes encrypted at rest under
// a key derived from a user passphrase (PBKDF2 -> AES-GCM, both via WebCrypto). Only public
// metadata (group key, address, roster) is kept in the clear so vaults can be listed for unlock;
// the secret share is NEVER written except as AES-GCM ciphertext.
//
// No dependencies: raw IndexedDB + crypto.subtle, with feature detection and explicit errors so a
// missing/blocked API surfaces a clear failure instead of a silent loss (a boundary, §6.8).

import { bytesToHex as hex, hexToBytes as unhex } from './bytes'

const DB_NAME = 'konclave'
const STORE = 'vaults'
const DB_VERSION = 1
const PBKDF2_ITERS = 210_000 // OWASP 2023 floor for PBKDF2-HMAC-SHA256

/**
 * Vault governance policy, set at creation and propagated to every device (public metadata).
 * `quorum` = sensitive metadata changes (signer names, beneficiaries) are group decisions;
 * `open` = any member edits directly. This is a PRODUCT rule the app helps a group honor, NOT a
 * cryptographic lock: moving funds always needs the FROST quorum regardless of this setting.
 * Undefined on older records is treated as `open` (the historical behavior) by the UI.
 */
export type Governance = 'open' | 'quorum'

/** Public, cleartext metadata kept for listing/unlock. Contains no secret material. */
export interface VaultPublic {
  id: string
  name?: string // user-given vault name (public metadata); falls back to a generated one in the UI
  governance?: Governance
  myName?: string // the name THIS device chose at create/join - lets the UI mark "you" correctly
  creatorName?: string // who set up the vault (propagated) - marks the creator, not a rotating coordinator
  groupKey: string // hex of the 32-byte group verifying key (the vault's public identity)
  address: string
  roster: string[]
  createdAt: number
}

/** Plaintext payload handed to saveVault; `sealedShare` is the secret to be encrypted at rest. */
export interface VaultData {
  name?: string
  governance?: Governance
  myName?: string
  creatorName?: string
  groupKey: Uint8Array
  address: string
  roster: string[]
  sealedShare: Uint8Array
  /** The per-vault access secret S (#388): every seated member holds it, an id-only outsider does
   *  not. Sealed at rest like the share. Optional so vaults created before #388 still save/load. */
  accessSecret?: Uint8Array
}

/** What loadVault returns after decrypting: the same shape, group key back as bytes. */
export interface VaultLoaded {
  name?: string
  governance?: Governance
  myName?: string
  creatorName?: string
  groupKey: Uint8Array
  address: string
  roster: string[]
  sealedShare: Uint8Array
  createdAt: number
  /** The per-vault access secret S (#388), or undefined for a vault saved before #388. */
  accessSecret?: Uint8Array
}

// Internal on-disk record. `cipher`/`salt`/`iv` protect `sealedShare`; `secretCipher`/`secretIv`
// protect the #388 access secret under the SAME derived key (a distinct iv per GCM rule); the rest
// is public. `secret*` are absent on pre-#388 records.
interface VaultRecord {
  id: string
  name?: string
  governance?: Governance
  myName?: string
  creatorName?: string
  groupKey: string
  address: string
  roster: string[]
  createdAt: number
  salt: Uint8Array
  iv: Uint8Array
  cipher: Uint8Array
  secretIv?: Uint8Array
  secretCipher?: Uint8Array
}


/**
 * Ask the browser to mark this origin's storage as persistent, so the encrypted share is NOT
 * evicted under storage pressure or the ~7-day inactivity clear (Safari ITP is the worst case).
 * Best-effort: Chromium/Firefox grant it based on engagement/PWA-install; iOS Safari usually
 * declines (there the safety net is social recovery, not persistence). Returns the granted state.
 * Never throws - a browser without the API just reports false. Call it from a user gesture
 * (e.g. right after the user protects a vault) for the best chance of a grant.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** True when this browser has both IndexedDB and WebCrypto (AES-GCM/PBKDF2 live under subtle). */
export function storageAvailable(): boolean {
  try {
    return (
      typeof indexedDB !== 'undefined' &&
      typeof crypto !== 'undefined' &&
      typeof crypto.subtle !== 'undefined' &&
      typeof crypto.getRandomValues === 'function'
    )
  } catch {
    return false
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser'))
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(new Error('Could not open the local database: ' + String(e)))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open the local database'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Local database transaction aborted'))
    tx.onerror = () => reject(tx.error ?? new Error('Local database transaction failed'))
  })
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Local database request failed'))
  })
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bufOf(salt), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// A fresh ArrayBuffer copy: an unambiguous BufferSource WebCrypto always accepts (TS 5.7's
// Uint8Array<ArrayBufferLike> does not satisfy the DOM BufferSource type; a real ArrayBuffer does).
function bufOf(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength)
  new Uint8Array(out).set(b)
  return out
}

/**
 * Encrypt `data.sealedShare` under a key derived from `passphrase` and store the vault.
 * Overwrites any existing record with the same id. Public metadata is stored in the clear.
 */
export async function saveVault(id: string, data: VaultData, passphrase: string): Promise<void> {
  if (!storageAvailable()) throw new Error('This browser cannot store the vault (no IndexedDB/WebCrypto)')
  if (!id) throw new Error('A vault id is required to save')
  if (!passphrase) throw new Error('A passphrase is required to save the vault')

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufOf(iv) }, key, bufOf(data.sealedShare))

  // The #388 access secret is sealed under the same key with its OWN iv (GCM requires a unique iv
  // per encryption). Absent when the vault has no S yet (pre-#388, or not distributed).
  let secretIv: Uint8Array | undefined
  let secretCipher: Uint8Array | undefined
  if (data.accessSecret) {
    secretIv = crypto.getRandomValues(new Uint8Array(12))
    const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufOf(secretIv) }, key, bufOf(data.accessSecret))
    secretCipher = new Uint8Array(buf)
  }

  const record: VaultRecord = {
    id,
    name: data.name,
    governance: data.governance,
    myName: data.myName,
    creatorName: data.creatorName,
    groupKey: hex(data.groupKey),
    address: data.address,
    roster: data.roster,
    createdAt: Date.now(),
    salt,
    iv,
    cipher: new Uint8Array(cipherBuf),
    secretIv,
    secretCipher,
  }

  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    await txDone(tx)
  } finally {
    db.close()
  }

  // The user just committed a share to this device: the strongest moment to ask the browser to
  // keep it. Fire-and-forget - a decline never blocks the save (recovery covers a lost share).
  void requestPersistentStorage()
}

/**
 * Decrypt and return a saved vault. Throws a clear error on a wrong passphrase or tampering
 * (AES-GCM authentication fails), and a distinct one when no such vault exists.
 */
export async function loadVault(id: string, passphrase: string): Promise<VaultLoaded> {
  if (!storageAvailable()) throw new Error('This browser cannot read the vault (no IndexedDB/WebCrypto)')

  const db = await openDb()
  let record: VaultRecord | undefined
  try {
    const tx = db.transaction(STORE, 'readonly')
    record = await reqDone(tx.objectStore(STORE).get(id) as IDBRequest<VaultRecord | undefined>)
    await txDone(tx)
  } finally {
    db.close()
  }
  if (!record) throw new Error('No saved vault with that id on this device')

  const key = await deriveKey(passphrase, record.salt)
  let plainBuf: ArrayBuffer
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufOf(record.iv) }, key, bufOf(record.cipher))
  } catch {
    throw new Error('Wrong passphrase, or the saved vault was tampered with')
  }

  // The #388 access secret, when this vault has one (same key, its own iv). The share already
  // authenticated the passphrase above, so a failure here is genuine corruption of that field.
  let accessSecret: Uint8Array | undefined
  if (record.secretCipher && record.secretIv) {
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufOf(record.secretIv) }, key, bufOf(record.secretCipher))
    accessSecret = new Uint8Array(buf)
  }

  return {
    name: record.name,
    governance: record.governance,
    myName: record.myName,
    creatorName: record.creatorName,
    groupKey: unhex(record.groupKey),
    address: record.address,
    roster: record.roster,
    sealedShare: new Uint8Array(plainBuf),
    createdAt: record.createdAt,
    accessSecret,
  }
}

/**
 * A portable vault export (#214). Carries the PUBLIC metadata plus the share exactly as it lives at
 * rest: AES-GCM ciphertext + its salt/iv. The secret is NEVER exported in the clear - the bundle is
 * only useful to someone who also knows the passphrase. Import re-persists it on another device (or
 * another backend), so a member is never locked to one machine. `groupKey`/`salt`/`iv`/`cipher` hex.
 */
export interface VaultExport {
  format: 'konclave-vault-export'
  version: 1
  exportedAt: number
  vault: {
    id: string
    name?: string
    governance?: Governance
    myName?: string
    creatorName?: string
    groupKey: string
    address: string
    roster: string[]
    createdAt: number
    salt: string
    iv: string
    cipher: string
  }
}

/**
 * Build a portable export of a saved vault. Verifies the passphrase decrypts the share first (so the
 * bundle is guaranteed usable on import), then serializes the ENCRYPTED record - never the plaintext
 * share. The result is safe to store anywhere: without the passphrase it is opaque ciphertext.
 */
export async function exportVault(id: string, passphrase: string): Promise<VaultExport> {
  if (!storageAvailable()) throw new Error('This browser cannot read the vault (no IndexedDB/WebCrypto)')
  if (!passphrase) throw new Error('A passphrase is required to export the vault')

  const db = await openDb()
  let record: VaultRecord | undefined
  try {
    const tx = db.transaction(STORE, 'readonly')
    record = await reqDone(tx.objectStore(STORE).get(id) as IDBRequest<VaultRecord | undefined>)
    await txDone(tx)
  } finally {
    db.close()
  }
  if (!record) throw new Error('No saved vault with that id on this device')

  // Verify the passphrase actually unlocks the share (AES-GCM auth). We export the original
  // ciphertext unchanged, so the SAME passphrase unlocks it after import.
  const key = await deriveKey(passphrase, record.salt)
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufOf(record.iv) }, key, bufOf(record.cipher))
  } catch {
    throw new Error('Wrong passphrase, or the saved vault was tampered with')
  }

  return {
    format: 'konclave-vault-export',
    version: 1,
    exportedAt: Date.now(),
    vault: {
      id: record.id,
      name: record.name,
      governance: record.governance,
      myName: record.myName,
      creatorName: record.creatorName,
      groupKey: record.groupKey,
      address: record.address,
      roster: record.roster,
      createdAt: record.createdAt,
      salt: hex(record.salt),
      iv: hex(record.iv),
      cipher: hex(record.cipher),
    },
  }
}

/** Parse + validate an export bundle (from a file or pasted text). Throws a clear error otherwise. */
export function parseVaultExport(raw: string): VaultExport {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    throw new Error('This does not look like a Konclave vault export (not valid JSON)')
  }
  const b = obj as Partial<VaultExport>
  if (!b || b.format !== 'konclave-vault-export') throw new Error('This is not a Konclave vault export')
  if (b.version !== 1) throw new Error('Unsupported export version - update Konclave')
  const v = b.vault
  if (!v || !v.id || !v.groupKey || !v.cipher || !v.salt || !v.iv || !Array.isArray(v.roster)) {
    throw new Error('The export is incomplete or corrupt')
  }
  return b as VaultExport
}

/**
 * Import a vault export onto THIS device. Verifies the passphrase decrypts the share before writing
 * anything (never imports a share the user cannot unlock). Refuses to overwrite an existing vault of
 * the same id unless `overwrite` is set. Returns the imported vault's public metadata.
 */
export async function importVault(
  bundle: VaultExport,
  passphrase: string,
  opts?: { overwrite?: boolean },
): Promise<VaultPublic> {
  if (!storageAvailable()) throw new Error('This browser cannot store the vault (no IndexedDB/WebCrypto)')
  if (!passphrase) throw new Error('A passphrase is required to import the vault')
  const v = bundle?.vault
  if (!v || !v.id || !v.cipher || !v.salt || !v.iv) throw new Error('The export is incomplete or corrupt')

  const salt = unhex(v.salt)
  const iv = unhex(v.iv)
  const cipher = unhex(v.cipher)

  // Verify the passphrase unlocks the share before persisting - so an import is always usable.
  const key = await deriveKey(passphrase, salt)
  try {
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufOf(iv) }, key, bufOf(cipher))
  } catch {
    throw new Error('Wrong passphrase for this export')
  }

  // Never silently clobber a different vault already on this device.
  const existing = (await listVaults()).find((s) => s.id === v.id)
  if (existing && !opts?.overwrite) throw new Error('A vault with this id already exists on this device')

  const record: VaultRecord = {
    id: v.id,
    name: v.name,
    governance: v.governance,
    myName: v.myName,
    creatorName: v.creatorName,
    groupKey: v.groupKey,
    address: v.address,
    roster: v.roster,
    createdAt: v.createdAt || Date.now(),
    salt,
    iv,
    cipher,
  }

  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    await txDone(tx)
  } finally {
    db.close()
  }

  void requestPersistentStorage()

  return {
    id: record.id,
    name: record.name,
    governance: record.governance,
    myName: record.myName,
    creatorName: record.creatorName,
    groupKey: record.groupKey,
    address: record.address,
    roster: record.roster,
    createdAt: record.createdAt,
  }
}

/** List saved vaults' public metadata (no secrets touched, no passphrase needed). */
export async function listVaults(): Promise<VaultPublic[]> {
  if (!storageAvailable()) return []
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return []
  }
  try {
    const tx = db.transaction(STORE, 'readonly')
    const records = await reqDone(tx.objectStore(STORE).getAll() as IDBRequest<VaultRecord[]>)
    await txDone(tx)
    return records
      .map((r) => ({ id: r.id, name: r.name, governance: r.governance, myName: r.myName, creatorName: r.creatorName, groupKey: r.groupKey, address: r.address, roster: r.roster, createdAt: r.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt)
  } finally {
    db.close()
  }
}

/** Patch a saved vault's PUBLIC metadata (never touches the sealed share, so no passphrase needed).
 *  Used when this device renames its own seat: the on-device `myName` must follow the roster so the
 *  UI keeps recognizing which member "you" are. A no-op if the vault or IndexedDB is unavailable. */
export async function updateVaultMeta(
  id: string,
  patch: Partial<Pick<VaultRecord, 'name' | 'myName' | 'creatorName'>>,
): Promise<void> {
  if (!storageAvailable()) return
  const db = await openDb()
  try {
    // Read and write in SEPARATE transactions. Awaiting the get inside a readwrite tx lets that tx
    // auto-commit before the put runs (a classic IndexedDB pitfall), so the patch silently never
    // persists - which is exactly what left a renamed member's `myName` stale on reload. Read first,
    // then open a fresh tx to write.
    const readTx = db.transaction(STORE, 'readonly')
    const rec = await reqDone(readTx.objectStore(STORE).get(id) as IDBRequest<VaultRecord | undefined>)
    await txDone(readTx)
    if (!rec) return
    const writeTx = db.transaction(STORE, 'readwrite')
    writeTx.objectStore(STORE).put({ ...rec, ...patch })
    await txDone(writeTx)
  } finally {
    db.close()
  }
}

/** Remove a saved vault (and its encrypted share) from this device. */
export async function deleteVault(id: string): Promise<void> {
  if (!storageAvailable()) return
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    await txDone(tx)
  } finally {
    db.close()
  }
}
