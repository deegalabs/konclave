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
  /** #388: whether this vault holds the per-vault secret S (its reads + signing room are gated).
   *  `false` = a legacy/open vault (a leaked id can read its books). Derived from the presence of the
   *  sealed S, never the secret itself, so it is safe to expose without unlocking. */
  secured?: boolean
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


/** What this browser promises about the stored share. `unknown` is its own answer, not a `false`. */
export type StoragePersistence = 'persisted' | 'evictable' | 'unknown'

/**
 * Ask the browser to mark this origin's storage as persistent, so the encrypted share is NOT
 * evicted under storage pressure or the ~7-day inactivity clear (Safari ITP is the worst case).
 * Best-effort: Chromium/Firefox grant it on engagement/PWA-install; iOS Safari usually declines.
 * Call it from a user gesture (right after the user commits a share) for the best chance.
 *
 * Returns THREE states, not a boolean, and that distinction is the point of #307: a browser with
 * no Storage API has not refused, it has failed to answer. Collapsing that into `false` - or into
 * a silently discarded result, which is what shipped - is how a member ends up on a browser that
 * will quietly delete their key share while the app assures them nothing is wrong.
 */
export async function storagePersistence(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<StoragePersistence> {
  try {
    if (!nav?.storage?.persist) return 'unknown'
    if (await nav.storage.persisted()) return 'persisted'
    return (await nav.storage.persist()) ? 'persisted' : 'evictable'
  } catch {
    return 'unknown'
  }
}

/**
 * Whether to tell the member their share can be deleted from under them.
 *
 * Anything but a granted persistence warns, `unknown` included. The costs are not symmetric: a
 * missed warning loses a key share and there is no recovery path today (#58 has the primitive and
 * neither the transport nor the UI), while a false warning is a banner someone reads twice. Same
 * fail-closed rule the propose gate follows: "I do not know" is never "all clear".
 */
export function warnsAboutEviction(state: StoragePersistence): boolean {
  return state !== 'persisted'
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
  // keep it. The request stays fire-and-forget, because a decline must not fail the save - but the
  // ANSWER is no longer discarded (#307). The Dashboard reads it back and warns, because nothing
  // else covers a share this browser deletes: recovery (#58) is a proven primitive with no
  // transport and no UI, so it cannot be the safety net this comment used to claim it was.
  void storagePersistence()
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

/** A v1 export: public metadata in the CLEAR plus the sealed share (salt/iv/cipher). Kept only so a
 *  backup made before v2 still imports; its metadata (id, address, member names) is cleartext, which
 *  is exactly what v2 closes. `secret*`/`beneficiaries` are optional (some late-v1 builds carried them). */
export interface VaultExportV1 {
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
    secretIv?: string
    secretCipher?: string
    beneficiaries?: unknown[]
  }
}

/** A v2 export: a SINGLE opaque blob. Everything - metadata, the share, the #388 secret S, the
 *  beneficiaries - is encrypted under the passphrase, so a leaked export file reveals nothing (not
 *  even the vault id, address, or member names) without the passphrase. Only the envelope
 *  (format/version/salt/iv) is cleartext, and none of it is sensitive. */
export interface VaultExportV2 {
  format: 'konclave-vault-export'
  version: 2
  exportedAt: number
  salt: string
  iv: string
  cipher: string
}

export type VaultExport = VaultExportV1 | VaultExportV2

/** The plaintext inside a v2 blob (encrypted at rest inside `cipher`). Hex for the byte fields. */
interface V2Payload {
  id: string
  name?: string
  governance?: Governance
  myName?: string
  creatorName?: string
  groupKey: string
  address: string
  roster: string[]
  createdAt: number
  share: string
  accessSecret: string | null
  beneficiaries: unknown[]
}

/**
 * Build a portable export of a saved vault. Verifies the passphrase decrypts the share first (so the
 * bundle is guaranteed usable on import), then serializes the ENCRYPTED record - never the plaintext
 * share. The result is safe to store anywhere: without the passphrase it is opaque ciphertext.
 */
/** The localStorage key the payee address-book lives under (mirrors `benefKey` in api.ts). Read/write
 *  it directly here so a vault export/import carries the beneficiaries without a cycle through api.ts. */
function beneficiariesKey(id: string): string {
  return `konclave.benef.${id}`
}
function readBeneficiaries(id: string): unknown[] {
  try {
    if (typeof localStorage === 'undefined') return []
    return JSON.parse(localStorage.getItem(beneficiariesKey(id)) ?? '[]') as unknown[]
  } catch {
    return []
  }
}
function writeBeneficiaries(id: string, list: unknown[]): void {
  try {
    if (typeof localStorage === 'undefined' || !Array.isArray(list) || list.length === 0) return
    localStorage.setItem(beneficiariesKey(id), JSON.stringify(list))
  } catch {
    /* storage blocked/full - the vault still imports, just without its payee list */
  }
}

/**
 * Build a portable v2 export: a SINGLE opaque blob. Everything the device needs to operate the vault
 * - metadata, the share, the #388 secret S, and the beneficiaries - is encrypted under the passphrase
 * (a fresh salt/iv), so a leaked export file reveals nothing without the passphrase, not even the
 * vault id, address, or member names. Verifies the passphrase unlocks the share before exporting, so
 * the bundle is guaranteed importable.
 */
export async function exportVault(id: string, passphrase: string): Promise<VaultExportV2> {
  if (!storageAvailable()) throw new Error('This browser cannot read the vault (no IndexedDB/WebCrypto)')
  if (!passphrase) throw new Error('A passphrase is required to export the vault')

  // loadVault decrypts the share + S with the passphrase (and throws on a wrong one), so the export
  // is guaranteed usable and we never touch ciphertext we could not open.
  const loaded = await loadVault(id, passphrase)

  const payload: V2Payload = {
    id,
    name: loaded.name,
    governance: loaded.governance,
    myName: loaded.myName,
    creatorName: loaded.creatorName,
    groupKey: hex(loaded.groupKey),
    address: loaded.address,
    roster: loaded.roster,
    createdAt: loaded.createdAt,
    share: hex(loaded.sealedShare),
    accessSecret: loaded.accessSecret ? hex(loaded.accessSecret) : null,
    beneficiaries: readBeneficiaries(id),
  }

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufOf(iv) }, key, bufOf(plaintext))

  return {
    format: 'konclave-vault-export',
    version: 2,
    exportedAt: Date.now(),
    salt: hex(salt),
    iv: hex(iv),
    cipher: hex(new Uint8Array(cipher)),
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
  const b = obj as {
    format?: unknown
    version?: unknown
    salt?: unknown
    iv?: unknown
    cipher?: unknown
    vault?: VaultExportV1['vault']
  }
  if (!b || b.format !== 'konclave-vault-export') throw new Error('This is not a Konclave vault export')
  if (b.version === 2) {
    if (!b.salt || !b.iv || !b.cipher) throw new Error('The export is incomplete or corrupt')
    return b as unknown as VaultExportV2
  }
  if (b.version === 1) {
    const v = b.vault
    if (!v || !v.id || !v.groupKey || !v.cipher || !v.salt || !v.iv || !Array.isArray(v.roster)) {
      throw new Error('The export is incomplete or corrupt')
    }
    return b as unknown as VaultExportV1
  }
  throw new Error('Unsupported export version - update Konclave')
}

/**
 * Import a vault export onto THIS device. Verifies the passphrase decrypts the share before writing
 * anything (never imports a share the user cannot unlock). Refuses to overwrite an existing vault of
 * the same id unless `overwrite` is set. Returns the imported vault's public metadata.
 */
/** What both export formats decode to before re-persisting: metadata + the raw share bytes + the
 *  optional #388 secret S + the optional beneficiaries. */
interface DecodedImport {
  id: string
  name?: string
  governance?: Governance
  myName?: string
  creatorName?: string
  groupKey: Uint8Array
  address: string
  roster: string[]
  createdAt: number
  share: Uint8Array
  accessSecret?: Uint8Array
  beneficiaries?: unknown[]
}

/** Decode a v2 opaque blob: decrypt the whole payload with the passphrase, then read the fields. */
async function decodeV2(b: VaultExportV2, passphrase: string): Promise<DecodedImport> {
  if (!b.salt || !b.iv || !b.cipher) throw new Error('The export is incomplete or corrupt')
  const key = await deriveKey(passphrase, unhex(b.salt))
  let plainBuf: ArrayBuffer
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufOf(unhex(b.iv)) }, key, bufOf(unhex(b.cipher)))
  } catch {
    throw new Error('Wrong passphrase for this export')
  }
  let p: V2Payload
  try {
    p = JSON.parse(new TextDecoder().decode(plainBuf)) as V2Payload
  } catch {
    throw new Error('The export is corrupt')
  }
  if (!p.id || !p.groupKey || !p.share || !Array.isArray(p.roster)) throw new Error('The export is incomplete or corrupt')
  return {
    id: p.id, name: p.name, governance: p.governance, myName: p.myName, creatorName: p.creatorName,
    groupKey: unhex(p.groupKey), address: p.address, roster: p.roster, createdAt: p.createdAt || Date.now(),
    share: unhex(p.share), accessSecret: p.accessSecret ? unhex(p.accessSecret) : undefined,
    beneficiaries: Array.isArray(p.beneficiaries) ? p.beneficiaries : undefined,
  }
}

/** Decode a legacy v1 bundle: the share is `cipher` (decrypt it); metadata is cleartext. */
async function decodeV1(b: VaultExportV1, passphrase: string): Promise<DecodedImport> {
  const v = b.vault
  if (!v || !v.id || !v.cipher || !v.salt || !v.iv) throw new Error('The export is incomplete or corrupt')
  const key = await deriveKey(passphrase, unhex(v.salt))
  let shareBuf: ArrayBuffer
  try {
    shareBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufOf(unhex(v.iv)) }, key, bufOf(unhex(v.cipher)))
  } catch {
    throw new Error('Wrong passphrase for this export')
  }
  let accessSecret: Uint8Array | undefined
  if (v.secretIv && v.secretCipher) {
    try {
      accessSecret = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufOf(unhex(v.secretIv)) }, key, bufOf(unhex(v.secretCipher))))
    } catch { /* a corrupt late-v1 S field: import the share without it */ }
  }
  return {
    id: v.id, name: v.name, governance: v.governance, myName: v.myName, creatorName: v.creatorName,
    groupKey: unhex(v.groupKey), address: v.address, roster: v.roster, createdAt: v.createdAt || Date.now(),
    share: new Uint8Array(shareBuf), accessSecret,
    beneficiaries: Array.isArray(v.beneficiaries) ? v.beneficiaries : undefined,
  }
}

/**
 * Import an export bundle (v1 or v2) and re-persist it on this device. The secrets (share, S) are
 * re-encrypted at rest under the passphrase with a fresh salt/iv; the beneficiaries are restored.
 * Refuses to clobber a different vault with the same id unless `overwrite`.
 */
export async function importVault(
  bundle: VaultExport,
  passphrase: string,
  opts?: { overwrite?: boolean },
): Promise<VaultPublic> {
  if (!storageAvailable()) throw new Error('This browser cannot store the vault (no IndexedDB/WebCrypto)')
  if (!passphrase) throw new Error('A passphrase is required to import the vault')

  const d = bundle?.version === 2
    ? await decodeV2(bundle, passphrase)
    : await decodeV1(bundle as VaultExportV1, passphrase)

  // Never silently clobber a different vault already on this device.
  const existing = (await listVaults()).find((s) => s.id === d.id)
  if (existing && !opts?.overwrite) throw new Error('A vault with this id already exists on this device')

  // Re-encrypt the secrets at rest (fresh salt/iv), preserving the original createdAt.
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufOf(iv) }, key, bufOf(d.share)))
  let secretIv: Uint8Array | undefined
  let secretCipher: Uint8Array | undefined
  if (d.accessSecret) {
    secretIv = crypto.getRandomValues(new Uint8Array(12))
    secretCipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufOf(secretIv) }, key, bufOf(d.accessSecret)))
  }

  const record: VaultRecord = {
    id: d.id, name: d.name, governance: d.governance, myName: d.myName, creatorName: d.creatorName,
    groupKey: hex(d.groupKey), address: d.address, roster: d.roster, createdAt: d.createdAt,
    salt, iv, cipher, secretIv, secretCipher,
  }

  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    await txDone(tx)
  } finally {
    db.close()
  }

  if (d.beneficiaries) writeBeneficiaries(d.id, d.beneficiaries)
  // Same as `saveVault`: ask on the strongest gesture and let the Dashboard surface the answer
  // (#307). An import is exactly when someone is recovering from a lost device, so a browser that
  // will evict again is the last thing to leave unsaid.
  void storagePersistence()

  return {
    id: record.id, name: record.name, governance: record.governance, myName: record.myName,
    creatorName: record.creatorName, groupKey: record.groupKey, address: record.address,
    roster: record.roster, createdAt: record.createdAt, secured: !!record.secretCipher,
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
      .map((r) => ({ id: r.id, name: r.name, governance: r.governance, myName: r.myName, creatorName: r.creatorName, groupKey: r.groupKey, address: r.address, roster: r.roster, createdAt: r.createdAt, secured: !!r.secretCipher }))
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
/**
 * Drop this device's copy of a vault - the record, and with it the sealed share (#426).
 *
 * Returns whether the record is ACTUALLY gone. `deleteVault` no-ops when storage is unavailable,
 * and telling a member their share is off the device while it is still there is worse than an
 * error: they would hand the machine on believing it holds nothing.
 */
export async function forgetVault(id: string): Promise<boolean> {
  await deleteVault(id)
  const left = await listVaults()
  return !left.some((v) => v.id === id)
}

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
