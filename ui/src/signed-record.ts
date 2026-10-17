// What this device signed, per vault and approval: the transactions its share went into, each as a
// hash of its sighash with the block it expires at. The rule that reads it is in WASM
// (`approvalDecision`), the same for every driver; this file only keeps the record.
//
// Each entry also keeps the consensus branch (`b`) the device READ in the header it checked, beside the
// expiry: a network upgrade can end a transaction's life before its expiry, and the rule that knows
// when is in WASM (`approvalDecision`). The branch is never taken from the wire, and an entry without
// one was written before it was kept and reads as NU6.3 (the rule says so, not this file). That
// default is safe HERE and not for the coordinator's send record, on purpose: this record is the
// device's own, written by the bundle that runs on this device, and a bundle that predates the branch
// cannot parse or sign a transaction of a later upgrade (its pczt refuses an unknown branch), so every
// entry without a branch really is NU6.3. The coordinator's record can be written by a build that did
// not keep the branch while its engine builds the later one, so there an absent branch is UNKNOWN.
// A NEW entry always carries a branch: `recordSigned` refuses to write one without.
//
// A hash, not the sighash: the sighash gives the txid, and the device's storage need not say which
// transactions it signed. The record lives in the browser's own storage so it outlives a reload,
// which a record in memory did not.
import { approvalDecision } from './wasm-pkg/konclave_wasm.js'

export interface RecordStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export interface SignedTx { h: string; e: number; b?: number }
export type Decision =
  | { kind: 'first' }
  | { kind: 'same' }
  | { kind: 'afterExpiry' }
  // `untilUnix` is computed in WASM by the rule the decision itself reads, so the time on the screen is
  // where the decision turns. `byEpoch`: a network upgrade, not the expiry, ends the earlier one.
  | { kind: 'second'; firstExpiry: number; untilUnix: number | null; untilHeight: number | null; byEpoch: boolean }

const key = (vault: string) => `konclave.signed.${vault}`

/** A consensus branch id as this device read it: a whole number from 1 to 2^32 - 1. */
export function validBranch(b: unknown): b is number {
  return typeof b === 'number' && Number.isInteger(b) && b > 0 && b <= 0xffff_ffff
}

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
  if (!Array.isArray(list) || list.some((t) => typeof t?.h !== 'string' || !Number.isInteger(t?.e) || (t?.b !== undefined && !Number.isInteger(t?.b)))) {
    throw new Error('signed record: unreadable')
  }
  return list
}

/** Record that this device's share went into the transaction `sighashHex`, expiring at `expiry` under
 *  consensus branch `branch`: both read by this device from the header it checked. */
export async function recordSigned(store: RecordStore, vault: string, proposal: string, sighashHex: string, expiry: number, branch: number): Promise<void> {
  // A branch that is missing or not a whole positive u32 would write nothing (JSON drops undefined),
  // and the entry would then read as NU6.3 for good: a later upgrade's transaction counted as dead
  // too early. Fail closed, before any share leaves (the machine records first).
  if (!validBranch(branch)) throw new Error('[record] the branch of what this device signed is missing')
  const h = await hashSighash(sighashHex)
  const all = readAll(store, vault)
  const list = readSigned(store, vault, proposal)
  if (list.some((t) => t.h === h)) return
  all[proposal] = [...list, { h, e: expiry, b: branch }]
  store.setItem(key(vault), JSON.stringify(all))
}

/** What the transaction `sighashHex` is for this approval, by the rule in WASM and this device's clock. */
export async function decideFor(store: RecordStore, vault: string, proposal: string, sighashHex: string): Promise<Decision> {
  const list = readSigned(store, vault, proposal)
  // `h:e:b`; an entry with no branch goes as `h:e`, which WASM reads as NU6.3.
  const signed = list.map((t) => (t.b === undefined ? `${t.h}:${t.e}` : `${t.h}:${t.e}:${t.b}`)).join(',')
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
