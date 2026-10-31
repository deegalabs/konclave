// "What changed" (#151, #125): what changed state since this device last looked.
//
// A local comparison: the states of the proposals, by id, as they were when the member last
// said "seen" on this device, against the list read now. Nothing is asked of the coordinator
// beyond the list it already serves, and nothing is written anywhere but this device.
import { bandOf } from './desk'
import type { Proposal } from './api'

/** The proposals' states by id, as last seen on this device. */
export type Snapshot = Record<string, string>

export type ChangeKind = 'arrived' | 'ready' | 'readyOthers' | 'sent' | 'confirmed' | 'refused' | 'withdrawn' | 'expired' | 'new' | 'changed'
export type Change = { id: string; kind: ChangeKind; from: string | null; to: string; proposal: Proposal }

const ORDER: ChangeKind[] = ['arrived', 'ready', 'readyOthers', 'sent', 'confirmed', 'refused', 'withdrawn', 'expired', 'new', 'changed']

function kindOf(from: string | null, p: Proposal, me: string | null): ChangeKind {
  const to = p.state
  if (from === null) return to === 'awaiting' && me !== null && bandOf(p, me) === 'vote' ? 'arrived' : 'new'
  // Whoever approved signs: "ready to sign" is a promise only to a member who approved.
  if (to === 'ready') return me !== null && bandOf(p, me) === 'sign' ? 'ready' : 'readyOthers'
  if (to === 'sent') return 'sent'
  if (to === 'confirmed') return 'confirmed'
  if (to === 'rejected') return 'refused'
  if (to === 'cancelled') return 'withdrawn'
  if (to === 'expired') return 'expired'
  return 'changed'
}

/** The changes between the snapshot and the list read now, most pressing first. `null` with no
 *  snapshot: a first look has nothing to compare, and "everything changed" would be a lie. A
 *  proposal that left the list is not a change this device can name. */
export function changesSince(prev: Snapshot | null, now: readonly Proposal[], me: string | null): Change[] | null {
  if (prev === null) return null
  const out: Change[] = []
  for (const p of now) {
    const from = Object.prototype.hasOwnProperty.call(prev, p.id) ? prev[p.id]! : null
    if (from === p.state) continue
    out.push({ id: p.id, kind: kindOf(from, p, me), from, to: p.state, proposal: p })
  }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
}

export function snapshotOf(now: readonly Proposal[]): Snapshot {
  const s: Snapshot = {}
  for (const p of now) s[p.id] = p.state
  return s
}
