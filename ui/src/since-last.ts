// "What changed" (#151, #125): what changed state since this device last looked.
//
// A local comparison: the states of the proposals, by id, as they were when the member last
// said "seen" on this device, against the list read now. Nothing is asked of the coordinator
// beyond the list it already serves, and nothing is written anywhere but this device.
import { bandOf, expiredByClock } from './desk'
import type { Proposal } from './api'

/** The proposals' states by id, as last seen on this device. */
export type Snapshot = Record<string, string>

export type ChangeKind = 'arrived' | 'ready' | 'sent' | 'confirmed' | 'refused' | 'withdrawn' | 'expired' | 'new' | 'changed'
export type Change = { id: string; kind: ChangeKind; from: string | null; to: string; proposal: Proposal }

const ORDER: ChangeKind[] = ['arrived', 'ready', 'sent', 'confirmed', 'refused', 'withdrawn', 'expired', 'new', 'changed']

/** The state as this device reads it: an open proposal past its deadline on this device's clock has
 *  expired, as on the desk, even before the coordinator recomputes it. */
const stateOf = (p: Proposal) => (expiredByClock(p) ? 'expired' : p.state)

function kindOf(from: string | null, to: string, p: Proposal, me: string | null): ChangeKind {
  // New since the last look and still open: for you when it waits on your vote. One that was created
  // and closed between two looks is named by how it ended, below.
  if (from === null && (to === 'awaiting' || to === 'ready')) return to === 'awaiting' && me !== null && bandOf(p, me) === 'vote' ? 'arrived' : 'new'
  // Ready names the state, not who signs: who may sign is the vault's rule, not this screen's.
  if (to === 'ready') return 'ready'
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
    const to = stateOf(p)
    const from = Object.prototype.hasOwnProperty.call(prev, p.id) ? prev[p.id]! : null
    if (from === to) continue
    out.push({ id: p.id, kind: kindOf(from, to, p, me), from, to, proposal: p })
  }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
}

/** The words for a change: its own for what is new, otherwise the state's word the proposal list
 *  already uses (`stamp.*`), so the two screens name a state alike. */
export function changeLabelKey(c: Change): string {
  return c.kind === 'arrived' || c.kind === 'new' ? `since.kind.${c.kind}` : `stamp.${c.to}`
}

export function snapshotOf(now: readonly Proposal[]): Snapshot {
  const s: Snapshot = {}
  for (const p of now) s[p.id] = stateOf(p)
  return s
}
