// What this device signed, per vault and approval: the transactions its share went into, each as a
// hash of its sighash with the block it expires at. The rule that reads it is in WASM
// (`approvalDecision`), the same for every driver; this file only keeps the record.
//
// A hash, not the sighash: the sighash gives the txid, and the device's storage need not say which
// transactions it signed. The record lives in the browser's own storage so it outlives a reload,
// which a record in memory did not.
import { approvalDecision } from './wasm-pkg/konclave_wasm.js'

export interface RecordStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export interface SignedTx { h: string; e: number }
export type Decision =
  | { kind: 'first' }
  | { kind: 'same' }
  | { kind: 'afterExpiry' }
  | { kind: 'second'; firstExpiry: number }

const key = (vault: string) => `konclave.signed.${vault}`

/** SHA-256 of the sighash bytes, lower-case hex. */
export async function hashSighash(sighashHex: string): Promise<string> {
  const hex = sighashHex.trim().toLowerCase()
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

function readAll(store: RecordStore, vault: string): Record<string, SignedTx[]> {
  // A record that cannot be read throws: not knowing what this device signed must never read as
  // having signed nothing.
  const raw = store.getItem(key(vault))
  if (raw === null) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('signed record: unreadable')
  return parsed as Record<string, SignedTx[]>
}

/** The transactions this device signed for `proposal` on `vault`. Throws when the record cannot be read. */
export function readSigned(store: RecordStore, vault: string, proposal: string): SignedTx[] {
  const list = readAll(store, vault)[proposal] ?? []
  if (!Array.isArray(list) || list.some((t) => typeof t?.h !== 'string' || !Number.isInteger(t?.e))) {
    throw new Error('signed record: unreadable')
  }
  return list
}

/** Record that this device's share went into the transaction `sighashHex`, expiring at `expiry`. */
export async function recordSigned(store: RecordStore, vault: string, proposal: string, sighashHex: string, expiry: number): Promise<void> {
  const h = await hashSighash(sighashHex)
  const all = readAll(store, vault)
  const list = readSigned(store, vault, proposal)
  if (list.some((t) => t.h === h)) return
  all[proposal] = [...list, { h, e: expiry }]
  store.setItem(key(vault), JSON.stringify(all))
}

/** What the transaction `sighashHex` is for this approval, by the rule in WASM and this device's clock. */
export async function decideFor(store: RecordStore, vault: string, proposal: string, sighashHex: string): Promise<Decision> {
  const list = readSigned(store, vault, proposal)
  const signed = list.map((t) => `${t.h}:${t.e}`).join(',')
  return JSON.parse(approvalDecision(signed, await hashSighash(sighashHex))) as Decision
}

/** This browser's storage for the record. Reading it throws when the browser refuses storage, and a
 *  record that cannot be read refuses to sign. */
export function browserRecordStore(): RecordStore {
  return {
    getItem: (k) => window.localStorage.getItem(k),
    setItem: (k, v) => window.localStorage.setItem(k, v),
  }
}
