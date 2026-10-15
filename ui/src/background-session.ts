// The app-level signing session (issue #49, Stage 3 wiring): what runs in the BACKGROUND while a
// member uses the Dashboard, so a send never sends them to /net. It composes the two extracted,
// tested pieces over ONE relay room (the vault's signing room):
//   • SigningSeats     - the rejoin/seating handshake (fixed seats from the DKG).
//   • BackgroundSigner - the FROST ceremony, gated by governance.
// This module is the transport-agnostic core; the thin React layer only pipes a RelaySession's
// messages into `onMessage` and calls `start()`/`stop()`. Unit-tested end to end over an in-memory
// relay, so the live layer is glue, not logic.

import { armExpiredBy, armOnArrival, emptyTally, tallyAfter, type Tally } from './signing-gate'
import { SigningSeats } from './signing-seats'
import { BackgroundSigner, type GovernanceGate } from './background-signer'
import type { SignPreview, SigningMaterial } from './signing-machine'
import type { GateDecision, PcztOutput } from './approved-payment'
import { signRejoin, rejoinIsProven, signArmed, armedIsProven, signUnarmed, unarmedIsProven } from './room-auth'
import { bytesToHex } from './bytes'

export interface BackgroundSessionDeps {
  /** This device's relay tag (a throwaway per-session pseudonym). */
  myTag: string
  /** This device's fixed 1-based FROST seat (from its restored share bundle). */
  mySeat: number
  /** This device's signing material (KeyPackage + group PublicKeyPackage + pubkeys). */
  signingMaterial: () => SigningMaterial
  /** The quorum threshold `t`. */
  threshold: () => number
  /** Send a raw string into the signing room (RelaySession.send). */
  send: (data: string) => Promise<boolean>
  /** Does a request pay EXACTLY what the quorum approved (#281)? Threaded to the machine, which
   *  calls it once per ceremony right after its own sighash check and before any share moves. */
  decideApproval: (outputs: PcztOutput[]) => GateDecision
  claim: (sighashHex: string, expiry: number) => boolean | Promise<boolean>
  record: (sighashHex: string, expiry: number) => Promise<void>
  /** Governance gate: whether this device signs this payment (policy lives in the caller). */
  gate: GovernanceGate
  onLog?: (line: string) => void
  onError?: (msg: string) => void
  onPhase?: (p: 'signing' | 'signed') => void
  onWhat?: (w: SignPreview | null) => void
  onSignature?: (hex: string, ok: boolean) => void
  onSeatCount?: (n: number) => void
  /** Armed seats changed. `triggerTag` is the tag of the device whose arming COMPLETED the quorum -
   *  the one, and only one, that asks the helper to build and broadcast. Null on every other
   *  message, so exactly one device triggers per quorum. */
  onArmed?: (seats: number[], triggerTag: string | null) => void
  /** Clock, injectable so the expiry rule is testable without waiting ten minutes. */
  now?: () => number
  /** An attempt failed elsewhere. Every device that signed learns it, not only the one that sent. */
  onFailed?: (code: FailureCode) => void
  /** Another device withdrew its signature for the open payment, live: the send went nowhere, so this
   *  device's owner signs the next transaction anew. Not called for history read back on open. */
  onWithdrawn?: () => void
}

/** A device announcing that its owner explicitly signed THIS proposal. Broadcast into the signing
 *  room so every device can see who has signed and agree, from one ordered log, on who sends. */
export interface ArmedMsg {
  type: 'armed'
  seat: number
  /** The proposal this arming is for, so a replayed arming from an older payment is ignored. */
  proposal: string
  /** When it was given (sender's clock, ms). Signatures expire on the wire the way they expire on
   *  the device, so the room cannot hold a payment hostage with signatures nobody remembers giving. */
  at: number
  /** Signed by this seat's own share, over seat+vault+tag+at+proposal (#425). Optional on the wire
   *  only so an older build's message parses; it is not counted without it. */
  sig?: string
}

/** Withdraws every signature for a payment. Published when an attempt FAILED: nothing moved, so the
 *  payment goes back to unsigned and everyone can decide again, rather than looking already-signed
 *  by devices that are gone.
 *
 *  It carries a COARSE reason and never the message. Only the device that sent gets the reply, so
 *  without this the others sit on "sending" and never learn it failed - but the message names the
 *  vault's balance, and the relay can read every body it carries. A code says enough for each device
 *  to write its own sentence, and tells the relay nothing it could not already infer from the
 *  silence that follows a failed ceremony. */
export type FailureCode = 'funds' | 'ceremony' | 'coordinator' | 'unknown'

export interface UnarmedMsg {
  type: 'unarmed'
  proposal: string
  code?: FailureCode
  /** The seat withdrawing. Present so the withdrawal can be attributed and therefore PROVEN: an
   *  unsigned `unarmed` used to be enough for anyone in the room to zero every device (#425). */
  seat?: number
  /** The time of the completed quorum this withdraws (SIGNER-SEAT1); signed, so an old withdrawal posted
   *  again cannot end a later completion. */
  of?: number
  /** Signed by that seat's own share, over seat+vault+tag+code+proposal(+of). */
  sig?: string
}

/** Whether a tally message fits this device's own seat: one under this device's tag carries its seat. */
export function tallyMessageFits(from: string, seat: number | undefined, myTag: string, mySeat: number): boolean {
  return from !== myTag || seat === mySeat
}

export class BackgroundSession {
  private readonly seats: SigningSeats
  private readonly signer: BackgroundSigner
  /** This device's share + the group PublicKeyPackage, to sign its own rejoin and verify peers' (#392). */
  private readonly signingMaterial: () => SigningMaterial
  private readonly myTag: string
  private readonly send: (data: string) => Promise<boolean>
  private readonly threshold: () => number
  private readonly onArmed?: (seats: number[], triggerTag: string | null) => void
  private readonly now: () => number
  private readonly onFailed?: (code: FailureCode) => void
  private readonly onWithdrawn?: () => void
  /** The ceremony log line. `/net` shows it; the app path leaves it unwired today, so a dropped
   *  tally message is not on screen there - see #425's note on the mixed-version window. */
  private readonly onLog?: (line: string) => void
  /** The current payment's tally (`tallyAfter`): each seat's standing signature, the window of the
   *  last completion, and the newest signatures taken. Keyed by SEAT so a device that reloads (new
   *  tag, same seat) replaces its own arming instead of counting twice. */
  private tally: Tally = emptyTally()
  /** The quorum's last completion for the current payment: the tag and seat whose signature completed
   *  it, and the newest signature's time. Set from the room's order alone, never from this device's
   *  clock, so every device holds the same one (SIGNER-SEAT1, review B1). It is the ONE record of who
   *  was named: the coordinator of the ceremony, the "someone is sending" line and the live decision
   *  to call the send (`onArmed`'s trigger) all read it. */
  private completion: { tag: string; seat: number; at: number; seats: number[] } | null = null
  /** Seats whose signature for this payment was dropped as dated too far ahead, logged once each. */
  private readonly warnedAhead = new Set<number>()
  /** Seats whose proven signature for this payment the tally ignored, logged once each. */
  private readonly warnedIgnored = new Set<number>()
  /** The payment whose signatures this session is counting. Anything else is ignored.
   *
   *  The signing room is PERMANENT (it is derived from the group key), so its log still holds every
   *  earlier payment's signatures, and a device joining replays the whole thing from seq 0. Without
   *  this scope, the last payment's two signatures rebuilt a full quorum for a payment that had
   *  already been sent - the panel then showed "2 of 2 signed" for a payroll nobody had signed, and
   *  never offered the button to sign it. */
  private currentProposal: string | null = null
  /** The payment the SIGNER's machine is bound to. Distinct from `currentProposal`, which
   *  follows the panel and goes null when it closes; this one only ever moves forward to the
   *  next real payment, so closing and reopening the same one keeps the ceremony alive. */
  private machineProposal: string | null = null

  constructor(deps: BackgroundSessionDeps) {
    this.send = deps.send
    this.signingMaterial = deps.signingMaterial
    this.myTag = deps.myTag
    this.threshold = deps.threshold
    this.onArmed = deps.onArmed
    this.onLog = deps.onLog
    this.now = deps.now ?? (() => Date.now())
    this.onFailed = deps.onFailed
    this.onWithdrawn = deps.onWithdrawn
    this.seats = new SigningSeats(deps.myTag, deps.mySeat, deps.onSeatCount)
    this.signer = new BackgroundSigner({
      signingMaterial: deps.signingMaterial,
      seatOf: (tag) => this.seats.seatOf(tag),
      seatIsProven: (tag) => this.seats.isProven(tag),
      mySeat: () => this.seats.mySeat(),
      myTag: () => deps.myTag,
      coordinatorTag: () => this.coordinatorTag(),
      threshold: deps.threshold,
      hasVault: () => true, // an unlocked, restored vault always exists
      decideApproval: deps.decideApproval,
      claim: deps.claim,
      record: deps.record,
      send: async (m) => { await this.send(JSON.stringify(m)) },
      rawSend: (data) => this.send(data),
      onLog: deps.onLog ?? (() => {}),
      onError: deps.onError ?? (() => {}),
      onPhase: deps.onPhase ?? (() => {}),
      onWhat: deps.onWhat ?? (() => {}),
      onSignature: deps.onSignature ?? (() => {}),
      tt: (k) => k, // the background path logs raw keys; the UI maps them if it wants
      gate: deps.gate,
    })
  }

  /** Announce this device's seat on the signing room, SIGNED with its share so peers can prove it
   *  (#392). Call once, right after opening the room. */
  async start(): Promise<void> {
    const ann = this.seats.announcement()
    const mat = this.signingMaterial()
    const sig = signRejoin(mat.keyPackage, ann.seat, bytesToHex(mat.groupVk), this.myTag)
    await this.send(JSON.stringify({ ...ann, sig }))
  }

  /** Pipe one relay message in. Routes `rejoin` to the seat table (then re-drives the signer, so a
   *  signing message that arrived before its sender was seated now proceeds); everything else goes
   *  to the signer. Call from RelaySession.onMessage. */
  async onMessage(from: string, data: string, historical = false): Promise<void> {
    let parsed: { type?: string; seat?: number; sig?: string; proposal?: string; at?: number; code?: FailureCode; of?: number } | null = null
    try {
      parsed = JSON.parse(data) as { type?: string; seat?: number; sig?: string; proposal?: string; at?: number; code?: FailureCode; of?: number }
    } catch {
      /* not JSON - hand to the signer, which ignores unparseable input */
    }
    // The tally messages are now PROVEN or ignored (#425). Unsigned, they let anyone who could
    // write to the room clear every device's count - repeatedly, so a payment never reached a
    // quorum. A message that does not verify is dropped and SAID, never dropped in silence: a
    // tally that quietly refuses to grow is the #356 failure, two members at "1 of 2" with both
    // present and nothing wrong on screen.
    // Tally messages are checked against this device's own seat.
    if ((parsed?.type === 'armed' || parsed?.type === 'unarmed') && !tallyMessageFits(from, parsed.seat, this.myTag, this.seats.mySeat())) {
      this.onLog?.(`~ ignored a ${parsed.type} message that does not match this device's seat`)
      return
    }
    if (parsed?.type === 'unarmed' && typeof parsed.proposal === 'string') {
      if (parsed.proposal !== this.currentProposal) return
      const proven =
        typeof parsed.seat === 'number' &&
        unarmedIsProven(this.signingMaterial(), parsed.seat, from, parsed.proposal, parsed.code, parsed.sig, parsed.of)
      if (!proven) {
        this.onLog?.(`~ ignored an unproven withdrawal for seat ${String(parsed.seat)}`)
        return
      }
      // Only the seat the room named sender withdraws (in the app, when its send failed), and only the
      // completion it names. From anyone else a proven withdrawal used to reset the tally, the coordinator
      // and every signer's consent, so a member who never signed could stop an approved send at every
      // attempt (review A1). The seat, not the tag: the relay takes the sender a client writes, so a tag
      // proves nothing (security delta B1), and the sender's own panel reopened has a new tag (B3). The
      // completion's time, signed inside: an old withdrawal posted again ends nothing later (B2). Read in
      // the room's order, a withdrawal still matches the completion it was made for.
      if (this.completion === null || parsed.seat !== this.completion.seat || parsed.of !== this.completion.at) {
        this.onLog?.(`~ ignored a withdrawal from a device that is not sending this payment (seat ${String(parsed.seat)})`)
        return
      }
      // A withdrawn attempt holds no window, so the next round may send at once; what was taken stays
      // taken, so the withdrawn signatures cannot be posted back in.
      this.tally = { ...this.tally, entries: new Map(), completedAt: null }
      this.completion = null
      this.onArmed?.([], null)
      // The reason is for the other devices. This one already says its own, and the room delivers a
      // device's messages back to it: taking its own withdrawal as a peer's failure replaced what it
      // said with "the send failed ... you can sign again".
      // A failure is news only when it happens: one read back from the room's history belongs to an
      // earlier attempt and must not replace what the screen knows about a later one.
      if (parsed.code && from !== this.myTag && !historical) this.onFailed?.(parsed.code)
      if (from !== this.myTag && !historical) this.onWithdrawn?.()
      return
    }
    if (parsed?.type === 'armed' && typeof parsed.seat === 'number' && typeof parsed.proposal === 'string') {
      const at = typeof parsed.at === 'number' ? parsed.at : null
      // The cheap gates run FIRST. A message for another payment, or one from further ahead than any
      // clock should be, is dropped without spending a verification on it; one for the open payment
      // costs one verification, which the relay's rate limit bounds. Expiry is not judged here:
      // `tallyAfter` decides it from the signatures' own times, the same on every device (#626).
      if (parsed.proposal !== this.currentProposal) return
      if (at === null) return // from before signatures carried a time: always a leftover
      if (armOnArrival(at, this.now()) === 'ahead') {
        // Dropping it is what stalled a send with nothing on screen (#626), so it is said, once per
        // seat and payment, and only for a signature the seat really made: a forged one must not use
        // up the warning for the real one, nor fill the console. The console carries it because the
        // app path leaves `onLog` unwired.
        if (!this.warnedAhead.has(parsed.seat) && armedIsProven(this.signingMaterial(), parsed.seat, from, at, parsed.proposal, parsed.sig)) {
          this.warnedAhead.add(parsed.seat)
          this.say(`~ ignored a signature for seat ${parsed.seat} dated ${Math.round((at - this.now()) / 1000)}s ahead of this device's clock`)
        }
        return
      }
      if (!armedIsProven(this.signingMaterial(), parsed.seat, from, at, parsed.proposal, parsed.sig)) {
        this.onLog?.(`~ ignored an unproven arming for seat ${parsed.seat}`)
        return
      }
      // The relay takes the sender a client writes, so a member could sign its own arming under another
      // device's tag and have the room name that device, which never signed (review A2). A tag already
      // seated at another seat is not this seat's.
      const tagSeat = this.seats.seatOf(from)
      if (tagSeat !== undefined && tagSeat !== parsed.seat) {
        this.onLog?.(`~ ignored an arming for seat ${parsed.seat} posted under seat ${tagSeat}'s device`)
        return
      }
      // A signature that completes the quorum names the coordinator: a request that was waiting for one
      // may now proceed, as a signing message waiting for its sender's seat does after a rejoin.
      if (this.handleArmed(from, parsed.seat, parsed.proposal, at)) await this.signer.retry()
      return
    }
    if (parsed?.type === 'rejoin' && typeof parsed.seat === 'number') {
      // A rejoin is PROVEN only if it carries a valid signature by that seat's own share (#392); an
      // unproven one may seat an empty seat but never evicts the holder, closing the seat-hijack (A4).
      const proven = rejoinIsProven(this.signingMaterial(), parsed.seat, from, parsed.sig)
      this.seats.handleRejoin(from, parsed.seat, proven)
      await this.signer.retry() // a pending signing message may now know this sender's seat
      return
    }
    // Everything above is replay-safe by construction and MUST see history: a device that reloads
    // mid-payment learns who already signed only by reading the room back, which is why arming is
    // scoped by proposal and expires on the wire (#324, #326). Starve that and two members sit at
    // "1 of 2" with both present and nothing wrong on screen (#356).
    //
    // The ceremony below is the opposite. A finished payment's `sreq` and round-1 commitments are
    // still in this permanent room, and feeding them to a fresh ceremony is what FROST rejects as
    // "the participant's commitment is incorrect" (#354). Nothing is lost by dropping them: a
    // device that reloads mid-ceremony left its nonces in the page it just closed, so it could not
    // have continued that ceremony anyway - it needs a new request, not the old one.
    if (historical) return
    await this.signer.feed(from, data)
  }

  /** Re-drive the signer without new input - e.g. after the owner arms a manual-mode payment, so a
   *  request that was pending on the governance gate now proceeds. */
  async retry(): Promise<void> {
    await this.signer.retry()
  }

  /** True once the current payment's ceremony finished (every spend). */
  isDone(): boolean {
    return this.signer.isDone()
  }

  /** How many distinct seats are present on the signing room. */
  seatCount(): number {
    return this.seats.seatCount()
  }

  /** Point this session at the payment now on screen. Changing payment starts a fresh tally, so a
   *  signature given for one payment can never count toward another - and, since #354, also resets
   *  the SIGNER, whose machine otherwise carries the previous ceremony's message, nonces,
   *  commitments and result straight into the next payment.
   *
   *  The reset fires only when moving to a DIFFERENT payment, never when the panel merely closes
   *  (`id === null`) and reopens on the same one. Closing must not throw away an in-flight
   *  ceremony, which is why `machineProposal` tracks the last payment the machine was bound to
   *  rather than following `currentProposal` down to null. */
  setProposal(id: string | null): void {
    if (this.currentProposal === id) return
    this.currentProposal = id
    this.tally = emptyTally()
    this.completion = null
    this.onArmed?.([], null)
    this.warnedAhead.clear()
    this.warnedIgnored.clear()
    if (id !== null && id !== this.machineProposal) {
      this.machineProposal = id
      this.signer.rearm()
    }
  }

  /** Announce that this device's owner explicitly signed `proposal`. Every device (this one
   *  included, the relay echoes it back) sees the same ordered log and agrees on who sends. `at` is
   *  the moment the owner signed, read once by the caller so its own window and the room's count
   *  are the same instant. */
  async arm(proposal: string, at: number = this.now()): Promise<void> {
    this.setProposal(proposal) // a no-op in the normal path; correct if the caller never scoped us
    const seat = this.seats.mySeat()
    const mat = this.signingMaterial()
    const sig = signArmed(mat.keyPackage, seat, bytesToHex(mat.groupVk), this.myTag, at, proposal)
    const msg: ArmedMsg = { type: 'armed', seat, proposal, at, sig }
    await this.send(JSON.stringify(msg))
  }

  /** Withdraw every signature for `proposal`: an attempt failed and nothing moved, so the payment
   *  goes back to unsigned on every device instead of looking signed by devices that have gone. */
  async unarm(proposal: string, code?: FailureCode): Promise<void> {
    const seat = this.seats.mySeat()
    const mat = this.signingMaterial()
    const of = this.completion?.at
    const sig = signUnarmed(mat.keyPackage, seat, bytesToHex(mat.groupVk), this.myTag, proposal, code, of)
    const msg: UnarmedMsg = { type: 'unarmed', proposal, seat, sig, ...(code ? { code } : {}), ...(of === undefined ? {} : { of }) }
    await this.send(JSON.stringify(msg))
  }

  /** Apply one signature. Signatures for any other payment are dropped, so replaying the room's
   *  history on join can never build a tally for the payment on screen. Who sends is `tallyAfter`'s
   *  decision, made from the room's order and the signatures' own times, so every device reaches the
   *  same one (#626). */
  private handleArmed(from: string, seat: number, proposal: string, at: number): boolean {
    if (proposal !== this.currentProposal) return false
    const step = tallyAfter(this.tally, seat, from, at, this.threshold())
    if (step.ignored) {
      // Said like a signature dated ahead, once per seat and payment: the member whose signature it
      // was sees no button until its own window ends, and the reason must be somewhere (#626 review).
      // Someone able to write to the room can post a seat's old signature again and use the line up;
      // the line it leaves says the same thing.
      const line = `~ ignored seat ${seat}'s signature: ${step.ignored === 'older' ? 'older than one already taken' : 'expired before the newest'}`
      if (this.warnedIgnored.has(seat)) this.onLog?.(line)
      else {
        this.warnedIgnored.add(seat)
        this.say(line)
      }
      return false
    }
    for (const s of step.pruned) {
      this.say(`~ seat ${s}'s signature, dated ${Math.round((step.tally.newest! - this.tally.entries.get(s)!.at) / 1000)}s before the newest, no longer counts`)
    }
    this.tally = step.tally
    // Who completed is recorded from the room alone, on every device the same (review B1).
    if (step.completes) this.completion = { tag: from, seat, at: step.tally.completedAt!, seats: [...step.tally.entries.keys()].sort((a, b) => a - b) }
    // Whether to CALL the send is this device's live decision, and only that reads the clock: a
    // completion read back from an old attempt holds its window like any other, so every device keeps
    // the same latch, but names nobody to send, because its sender's tab is gone (#326).
    const named = step.completes && !armExpiredBy(at, this.now()) ? from : null
    this.onArmed?.(this.armedSeats(), named)
    return step.completes
  }

  /** The tag that coordinates the payment's ceremony: the one whose signature last completed the
   *  quorum, or null while none has (SIGNER-SEAT1). */
  coordinatorTag(): string | null {
    return this.completion?.tag ?? null
  }

  /** Whose signature completed the quorum and when (its newest signature's time), for the screen to
   *  name the device that is sending. Null while none has. */
  completed(): { seat: number; at: number; seats: number[] } | null {
    return this.completion ? { seat: this.completion.seat, at: this.completion.at, seats: this.completion.seats } : null
  }

  /** The seats whose signature for the current proposal still counts, ascending: what the screen
   *  shows. The tally forgets an expired signature when the next one arrives; this also leaves out
   *  one that expired since, by this device's clock, so the count does not show a signature from an
   *  old attempt as standing. */
  armedSeats(): number[] {
    const now = this.now()
    return [...this.tally.entries.entries()].filter(([, e]) => !armExpiredBy(e.at, now)).map(([s]) => s).sort((a, b) => a - b)
  }

  /** Would this device's signature, made now, name it the sender? `tallyAfter` itself, asked with a
   *  signature dated now, so the panel words the confirm from the decision and not from a copy of it
   *  (#626 review). */
  wouldComplete(now: number = this.now()): boolean {
    return tallyAfter(this.tally, this.seats.mySeat(), this.myTag, now, this.threshold()).completes
  }

  /** Is a sender the room named still within its window? What lets the screen say someone is
   *  sending: a full count alone does not, once that window has passed with nobody named since. */
  sendingNamed(now: number = this.now()): boolean {
    return this.completion !== null && !armExpiredBy(this.completion.at, now)
  }

  /** A tally line: to the ceremony log, and to the console, because the app path leaves `onLog`
   *  unwired and a dropped signature is what stalled sends with nothing on screen (#626). No
   *  secret: a seat number and a number of seconds. */
  private say(line: string): void {
    this.onLog?.(line)
    console.warn(`[konclave] ${line}`)
  }

  /** Reset for a NEXT payment. Also clears `machineProposal`, so the next `setProposal` binds the
   *  machine again rather than assuming it is already pointed at the right payment. */
  rearm(): void {
    this.signer.rearm()
    this.tally = emptyTally()
    this.completion = null
    this.currentProposal = null
    this.machineProposal = null
  }
}
