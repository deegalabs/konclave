// Has this payment actually landed in a block?
//
// The screens used to answer that by reading the proposal's own state, and the proposal cannot
// know. `HelperProposal::recompute` early-returns on `"sent"` and NOTHING in the coordinator ever
// writes `"confirmed"` - grep it - so on the web path that state is unreachable. The Dashboard read
// `sent || confirmed` and rendered a green chip saying **Confirmed** over a transaction still
// sitting in the mempool. On the accounting surface, to a treasurer.
//
// Confirmation is a fact about the CHAIN, so it is derived from the chain: the vault's transaction
// list carries `mined_height`, and a proposal carries the `txid` it broadcast. Joining the two is
// the only way to say the word honestly.
//
// IT FAILS CLOSED, and that is the property worth keeping. Every path that cannot prove a block
// answers `broadcast`, never `confirmed`: no txid, no transaction list, a list that does not
// contain the txid, a height of zero. Being slow to call something confirmed costs a member
// nothing; being early tells them their money arrived when it has not.
//
// Note what this does NOT change. Counting a broadcast payment as money that LEFT the vault is
// correct - it did - so the ledger's totals and filters, which ask that question, keep treating
// `sent` and `confirmed` together. Only the word "confirmed" was the lie.
import type { WalletTx } from './helper'

export type Settlement =
  /** Not broadcast yet: awaiting approval, ready to sign, refused, expired. */
  | { kind: 'open' }
  /** On the wire and out of the vault, with no block behind it yet - or none we can see. */
  | { kind: 'broadcast' }
  /** In a block, and we can name it. The only way to reach this is a real height. */
  | { kind: 'confirmed'; height: number }

const OUTGOING = new Set(['sent', 'confirmed'])

/**
 * What can honestly be said about a proposal's settlement, given the vault's transactions.
 *
 * `txs` of `null` means "not loaded or unavailable", which is a reason to say less, not to guess.
 */
export function settlementOf(
  p: { state: string; txid?: string | null },
  txs: readonly WalletTx[] | null,
): Settlement {
  if (!OUTGOING.has(p.state)) return { kind: 'open' }
  const txid = p.txid?.trim()
  if (!txid || !txs) return { kind: 'broadcast' }
  const hit = txs.find((t) => t.txid === txid)
  const h = hit?.mined_height
  // `> 0` rather than `!= null`: a zero height is not block zero, it is a wallet that has the
  // transaction and no block for it.
  return typeof h === 'number' && h > 0 ? { kind: 'confirmed', height: h } : { kind: 'broadcast' }
}

/** True only for a settlement that named a block. Kept as a function so no caller re-invents the
 *  check as `s.kind === 'confirmed'` and later widens it to include `broadcast`. */
export function isConfirmed(s: Settlement): s is { kind: 'confirmed'; height: number } {
  return s.kind === 'confirmed'
}
