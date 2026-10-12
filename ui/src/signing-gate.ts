// The governance policy for background signing (issue #49), as a pure function that produces the
// GovernanceGate the BackgroundSigner consumes. This is the "sign async/sync, configurable per vault
// and changeable by a proposal" layer: the vault carries a signing MODE, and a device only ever
// contributes its share to a payment its owner's quorum APPROVED.
//
//   • auto   - once the proposal is approved by quorum, this device signs automatically (no per-
//              payment click). Good for small, trusted, high-throughput vaults.
//   • manual - even after quorum approval, this device signs only when its owner EXPLICITLY arms
//              this specific payment. A single click never fires money; the owner confirms each one.
//
// The mode is a per-vault setting a governance proposal can change; the gate reads it live, so a
// change takes effect on the next payment. Approval and arming are looked up by the payment's
// sighash (the on-device binding - see H1), never by a mutable proposal label.

import type { GovernanceGate } from './background-signer'

export type SigningMode = 'auto' | 'manual'

/**
 * How long an arming counts. Consent to spend should not outlive the act that gave it: a device
 * left open on a signed payment would otherwise contribute its share to a request that arrives
 * hours later, with nobody watching. The window covers a whole legitimate ceremony with room to
 * spare (the coordinator builds and proves for a minute or two, then waits up to five for the
 * shares) and nothing beyond it. Past it, the device asks its owner to sign again.
 */
export const ARM_TTL_MS = 10 * 60 * 1000

/** Whether an arming made at `armedAt` still counts at `now`. Never armed (`null`) is never live,
 *  and a clock that jumped backwards reads as not-yet-armed rather than as armed forever. */
export function armIsLive(armedAt: number | null, now: number, ttlMs: number = ARM_TTL_MS): boolean {
  if (armedAt === null) return false
  const age = now - armedAt
  return age >= 0 && age <= ttlMs
}

/** Whether this device's owner has signed the payment now open, within their own window: the one
 *  thing that lets this device contribute its share in manual mode. It reads only this device's
 *  record of its owner's signature and its own clock. Who the room names as sender never opens it:
 *  outside its owner's own window, a device contributes nothing (#626). */
export function ownerArmed(
  s: { armedProposal: string | null; armedAt: number | null; activeId: string | null },
  now: number,
): boolean {
  const open = s.activeId !== null && s.activeId !== ''
  return armIsLive(s.armedAt, now) && open && s.armedProposal === s.activeId
}

/**
 * How far ahead of this device's clock another device's signature may be dated and still count
 * (#626). A signature carries the time on its signer's clock. `armIsLive` read one dated a second
 * ahead as not yet made, dropped it, and the room never sent it again, so the member who signed last
 * never saw the quorum close and nobody sent. Clocks a second or two apart are ordinary.
 */
export const ARM_SKEW_MS = 2 * 60 * 1000

/** Whether another device's signature, dated `at` by its clock, is taken into the tally when it
 *  arrives here at `now`. One from more than `ARM_SKEW_MS` ahead is not (`ahead`), and is reported,
 *  because dropping it is a choice the device should say it made. Everything else is taken, however
 *  old by this device's clock: whether it still counts is decided by `tallyAfter` from the times the
 *  signatures carry, values every device holds the same. Any cut by this device's clock made a device
 *  that opened the payment later disagree with the others about who sends: first at the window
 *  (#626, S6), then at twice it (#626 review, C1). Only the open payment's signatures get this far,
 *  each costing one verification, which the relay's rate limit bounds. The device's own signature is
 *  judged by `armIsLive`, on its own clock. */
export function armOnArrival(at: number, now: number): 'counts' | 'ahead' {
  return now - at < -ARM_SKEW_MS ? 'ahead' : 'counts'
}

/** Whether a signature dated `earlierAt` has expired by the time of one dated `laterAt`. Measured
 *  between two times every device holds the same, so every device forgets the same signatures at the
 *  same point in the room (#626). */
export function armExpiredBy(earlierAt: number, laterAt: number): boolean {
  return laterAt - earlierAt > ARM_TTL_MS
}

/** One seat's standing signature in a payment's tally: who posted it and when, by its signer. */
export interface TallyEntry { tag: string; at: number }

/** A payment's tally, as every device builds it from the room. */
export interface Tally {
  /** Seat -> its standing signature. */
  entries: Map<number, TallyEntry>
  /** The newest `at` among the signatures of the quorum that last completed, or null. */
  completedAt: number | null
  /** Seat -> the newest `at` ever taken for this payment. Kept through expiry and withdrawal, so a
   *  seat's old signature posted again never comes back. */
  seen: Map<number, number>
  /** The newest `at` taken for this payment. */
  newest: number | null
}

export const emptyTally = (): Tally => ({ entries: new Map(), completedAt: null, seen: new Map(), newest: null })

/** The tally after one signature: whether it completed the quorum, which seats it forgot, and why it
 *  was ignored, if it was. */
export interface TallyStep { tally: Tally; completes: boolean; pruned: number[]; ignored: 'older' | 'expired' | null }

/** What a signature does to the tally: the decision of who sends, and the one rule for it. The
 *  session applies it to each signature that arrives and asks it, with a signature dated now,
 *  whether this device's would send (`wouldComplete`), so the two cannot drift (#626 review). It
 *  reads only the room's order and the times the signatures carry, so every device decides alike.
 *
 *  - A seat's signature no newer than one already taken from that seat is ignored, and so is one
 *    that expired by the newest signature taken: an old signature posted again by anyone who can
 *    write to the room, or delivered late, must not replace consent given since or reopen a window.
 *  - Signatures that expired by the newest one leave the tally.
 *  - The quorum completes when a signature leaves `t` or more standing, and then not again until a
 *    signature dated more than the window after the newest one of that quorum: a member who signs
 *    again while the named sender's attempt may still be running is not a second sender. After the
 *    window the next signature completes again, with the ones still standing, whichever seat it
 *    comes from and however many there are: that is how a payment whose sender vanished is sent
 *    (#334). The sender checks the payment before asking for the send, so one that already went out
 *    is not sent again (`send-preflight.ts`).
 */
export function tallyAfter(tally: Tally, seat: number, tag: string, at: number, t: number): TallyStep {
  const last = tally.seen.get(seat)
  if (last !== undefined && at <= last) return { tally, completes: false, pruned: [], ignored: 'older' }
  if (tally.newest !== null && armExpiredBy(at, tally.newest)) return { tally, completes: false, pruned: [], ignored: 'expired' }
  const newest = tally.newest === null ? at : Math.max(tally.newest, at)
  const seen = new Map(tally.seen).set(seat, at)
  const entries = new Map<number, TallyEntry>()
  const pruned: number[] = []
  for (const [s, e] of tally.entries) {
    if (armExpiredBy(e.at, newest)) pruned.push(s)
    else entries.set(s, e)
  }
  entries.set(seat, { tag, at })
  const latchOpen = tally.completedAt === null || armExpiredBy(tally.completedAt, at)
  const completes = t > 0 && entries.size >= t && latchOpen
  const completedAt = completes ? Math.max(...[...entries.values()].map((e) => e.at)) : tally.completedAt
  return { tally: { entries, completedAt, seen, newest }, completes, pruned, ignored: null }
}

export interface SigningGateInput {
  /** The vault's current signing mode (read live, so a governance change takes effect immediately). */
  mode: () => SigningMode
  /** Is the payment with this sighash approved by quorum (product: its proposal is Ready)? */
  isApproved: (sighash: string) => boolean
  /** In manual mode, has the owner explicitly armed THIS payment to sign? (ignored in auto mode) */
  isArmed: (sighash: string) => boolean
}

/**
 * Build the governance gate. A device NEVER signs an unapproved payment. Beyond that, `auto` signs
 * approved payments on its own; `manual` also requires the owner to arm the specific payment.
 * Returning false leaves the request PENDING (not rejected), so arming (or a later approval) plus a
 * retry proceeds - exactly the manual-approval path the BackgroundSigner supports.
 */
export function makeSigningGate(input: SigningGateInput): GovernanceGate {
  return ({ sighash }) => {
    if (!input.isApproved(sighash)) return false // unapproved: never sign
    return input.mode() === 'auto' ? true : input.isArmed(sighash)
  }
}
