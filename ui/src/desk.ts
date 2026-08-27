// The dashboard desk: which open proposals this device should see, and in what order.
//
// The old dashboard picked ONE proposal (`awaiting[0]`, or the first ready only when nothing was
// awaiting) and called it "needs you". Three things were wrong with that: a proposal at full quorum
// disappeared the moment somebody opened a new one, the pick was array order rather than urgency,
// and "needs you" was decided by state alone, so it kept saying that to a member who had already
// voted.
//
// This module is the fix, and it is deliberately a pure function: no React, no network, no clock
// reading of its own. It answers one question - given these proposals and who I am, what is on my
// desk and what is on top - so the ordering can be tested without a browser.
import type { Proposal } from './api'

/** The four bands, most urgent first. See `bandOf` for what each one means. */
export type Band = 'sign' | 'vote' | 'wait' | 'voted'

const RANK: Record<Band, number> = { sign: 0, vote: 1, wait: 2, voted: 3 }

export type DeskItem = {
  p: Proposal
  band: Band
  /**
   * True when this device's signature is what completes the ceremony: it approved, the quorum is
   * met, and signing therefore BROADCASTS. The card says so out loud, because the product rule is
   * "whoever approved signs, and the last to sign sends" - a click that spends is never a surprise.
   */
  last: boolean
}

export type Desk = {
  /** Ordered, most urgent first. Empty when nothing is open. */
  items: DeskItem[]
  /** How many proposals are open in total (the queue may render fewer). */
  open: number
  /**
   * False when this device does not know its own member name. Every band is then a statement about
   * the VAULT, not about the person, and the UI must use neutral copy: we will not tell someone
   * their vote is missing when we cannot tell whether they voted.
   */
  personal: boolean
}

/** A proposal still consuming vault funds and still able to move. */
export function isOpen(p: Proposal): boolean {
  return p.state === 'awaiting' || p.state === 'ready'
}

function voted(p: Proposal, me: string): boolean {
  return p.approvals.includes(me) || p.refusals.includes(me)
}

/**
 * Which band a proposal falls in for this device.
 *
 * - `sign`  ready AND I approved. The money is already committed and I am one of the hands holding
 *           it up. Nothing outranks this.
 * - `vote`  awaiting AND I have not voted. The vault is stopped waiting on me.
 * - `wait`  ready, I did not approve. Committed funds, but the others unblock it, not me.
 * - `voted` awaiting, I already voted. Visible, but there is nothing for me to do.
 *
 * With no known identity we cannot make a personal claim, so ready lands in `sign` and awaiting in
 * `vote` purely for ordering, and `Desk.personal` tells the UI to drop the personal wording.
 */
export function bandOf(p: Proposal, me: string | null): Band {
  const ready = p.state === 'ready'
  if (me === null) return ready ? 'sign' : 'vote'
  if (ready) return p.approvals.includes(me) ? 'sign' : 'wait'
  return voted(p, me) ? 'voted' : 'vote'
}

/**
 * Sort key inside a band: soonest expiry first, then oldest first, then id. A proposal with no
 * expiry sorts after every proposal that has one - an open-ended item is never more urgent than a
 * deadline. The id tiebreak keeps the order stable across polls, so rows do not swap under a cursor.
 */
function within(a: Proposal, b: Proposal): number {
  const ax = a.expiry_unix ?? Number.POSITIVE_INFINITY
  const bx = b.expiry_unix ?? Number.POSITIVE_INFINITY
  if (ax !== bx) return ax - bx
  const ac = a.created_at ?? 0
  const bc = b.created_at ?? 0
  if (ac !== bc) return ac - bc
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Rank the open proposals for this device.
 *
 * `me` is this device's member name (the identity the vault votes by) or null when unknown.
 * `threshold` is the vault quorum; it is only used to decide whether signing would SEND.
 */
export function rankDesk(proposals: Proposal[], me: string | null, threshold: number): Desk {
  const open = proposals.filter(isOpen)
  const items: DeskItem[] = open
    .map((p) => {
      const band = bandOf(p, me)
      const last =
        band === 'sign' && me !== null && threshold > 0 && p.approvals.length >= threshold
      return { p, band, last }
    })
    .sort((x, y) => (RANK[x.band] !== RANK[y.band] ? RANK[x.band] - RANK[y.band] : within(x.p, y.p)))
  return { items, open: open.length, personal: me !== null }
}
