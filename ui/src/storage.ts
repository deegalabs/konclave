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

const DB_NAME = 'konclave'
const STORE = 'vaults'
const DB_VERSION = 1
const PBKDF2_ITERS = 210_000 // OWASP 2023 floor for PBKDF2-HMAC-SHA256

/** Public, cleartext metadata kept for listing/unlock. Contains no secret material. */
export interface VaultPublic {
  id: string
  groupKey: string // hex of the 32-byte group verifying key (the vault's public identity)
  address: string
  roster: string[]
  createdAt: number
}

/** Plaintext payload handed to saveVault; `sealedShare` is the secret to be encrypted at rest. */
export interface VaultData {
  groupKey: Uint8Array
  address: string
  roster: string[]
  sealedShare: Uint8Array
}

/** What loadVault returns after decrypting: the same shape, group key back as bytes. */
export interface VaultLoaded {
  groupKey: Uint8Array
  address: string
  roster: string[]
  sealedShare: Uint8Array
  createdAt: number
}

// Internal on-disk record. `cipher`/`salt`/`iv` protect `sealedShare`; the rest is public.
interface VaultRecord {
  id: string
  groupKey: string
  address: string
  roster: string[]
  createdAt: number
  salt: Uint8Array
  iv: Uint8Array
  cipher: Uint8Array
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function unhex(s: string): Uint8Array {
  const clean = s.trim().toLowerCase()
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
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

  const record: VaultRecord = {
    id,
    groupKey: hex(data.groupKey),
    address: data.address,
    roster: data.roster,
    createdAt: Date.now(),
    salt,
    iv,
    cipher: new Uint8Array(cipherBuf),
  }

  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    await txDone(tx)
  } finally {
    db.close()
  }
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

  return {
    groupKey: unhex(record.groupKey),
    address: record.address,
    roster: record.roster,
    sealedShare: new Uint8Array(plainBuf),
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
      .map((r) => ({ id: r.id, groupKey: r.groupKey, address: r.address, roster: r.roster, createdAt: r.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt)
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
