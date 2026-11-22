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
import { hasVoted, myStance, stancesKnown } from './stance'

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

/**
 * "Can this proposal still move": awaiting or ready, and not past its deadline on this device's
 * clock. The ONE rule for the desk, the reservation (`reservedZatOf`) and the ledger's Open total,
 * filter and column; a clock-expired proposal used to leave the desk while still holding funds and
 * counting as Open in the ledger. One argument on purpose: it is passed to `.filter`, which would
 * hand it the index as a clock.
 */
export function isOpen(p: Proposal): boolean {
  return stateOpen(p) && !pastDeadline(p, Date.now())
}

// The state half alone, for `rankDesk`, which reads no clock: its callers filter `expiredByClock`.
const stateOpen = (p: Proposal) => p.state === 'awaiting' || p.state === 'ready'
const pastDeadline = (p: Proposal, now: number) => !!p.expiry_unix && p.expiry_unix * 1000 < now

/**
 * An open proposal whose deadline has passed on this device's clock. The coordinator expires an
 * awaiting AND a ready proposal once it recomputes them; until it does, the device treats both as
 * closed, so neither sits first on the desk as "Sign" or "Your vote" with a clock that has run out.
 * `now` is a parameter so the rule can be tested without touching the clock.
 */
export function expiredByClock(p: Proposal, now: number = Date.now()): boolean {
  return stateOpen(p) && pastDeadline(p, now)
}

/**
 * The stamp on a row. It falls back to neutral, vault-level wording when this device does not know
 * its own member name (`Desk.personal === false`): we will not say "Your vote" to someone when we
 * cannot tell whether they voted. The Dashboard carries the same rule; this is the one the list reads.
 */
export function stampKey(band: Band, personal: boolean): string {
  if (!personal) return band === 'sign' ? 'stamp.ready' : 'stamp.awaiting'
  return `desk.band.${band}`
}

/**
 * The one-line summary on the Dashboard's main card. Like the stamp (`stampKey`), it falls back to
 * neutral, vault-level wording when the desk is impersonal (`Desk.personal === false`: this device
 * does not know its member, or the coordinator did not say who voted, #575): we will not tell
 * someone their vote is missing when we cannot tell whether they voted.
 */
export function lineKey(band: Band, personal: boolean): string {
  if (!personal) return band === 'sign' ? 'dashboard.readyToSign' : 'proposals.awaitingApproval'
  return `desk.line.${band}`
}

function voted(p: Proposal, me: string, seat?: number): boolean {
  return hasVoted(p, { seat, name: me })
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
export function bandOf(p: Proposal, me: string | null, seat?: number): Band {
  const ready = p.state === 'ready'
  // A coordinator that did not say who voted (#575) leaves us as impersonal as an unknown member.
  if (me === null || !stancesKnown(p)) return ready ? 'sign' : 'vote'
  if (ready) return myStance(p, { seat, name: me }) === 'approved' ? 'sign' : 'wait'
  return voted(p, me, seat) ? 'voted' : 'vote'
}

/** The band this device may claim for ITS member: null when it does not know who it is, or when the
 *  proposal's answer did not say who voted (an older coordinator, #575). */
export function personalBand(p: Proposal, me: string | null, seat?: number): Band | null {
  return me === null || !stancesKnown(p) ? null : bandOf(p, me, seat)
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
export function rankDesk(proposals: Proposal[], meName: string | null, threshold: number, seat?: number): Desk {
  const open = proposals.filter(stateOpen)
  // Personal wording only where every open proposal says who voted: one that does not makes the desk's
  // 'Your vote' a claim the coordinator never made.
  const known = open.every(stancesKnown)
  const me = known ? meName : null
  const items: DeskItem[] = open
    .map((p) => {
      const band = bandOf(p, me, seat)
      const last =
        // Signing would send when the coordinator says the quorum is in: `ready`, with its own count
        // of approving seats at the threshold. The app does not count approvals itself (#575).
        band === 'sign' && me !== null && threshold > 0 && p.state === 'ready' && (p.approvals_count ?? 0) >= threshold
      return { p, band, last }
    })
    .sort((x, y) => (RANK[x.band] !== RANK[y.band] ? RANK[x.band] - RANK[y.band] : within(x.p, y.p)))
  return { items, open: open.length, personal: me !== null }
}
