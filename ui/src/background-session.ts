// The app-level signing session (issue #49, Stage 3 wiring): what runs in the BACKGROUND while a
// member uses the Dashboard, so a send never sends them to /net. It composes the two extracted,
// tested pieces over ONE relay room (the vault's signing room):
//   • SigningSeats     - the rejoin/seating handshake (fixed seats from the DKG).
//   • BackgroundSigner - the FROST ceremony, gated by governance.
// This module is the transport-agnostic core; the thin React layer only pipes a RelaySession's
// messages into `onMessage` and calls `start()`/`stop()`. Unit-tested end to end over an in-memory
// relay, so the live layer is glue, not logic.

import { armIsLive } from './signing-gate'
import { SigningSeats } from './signing-seats'
import { BackgroundSigner, type GovernanceGate } from './background-signer'
import type { SigningMaterial } from './signing-machine'

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
  /** Governance gate: whether this device signs this payment (policy lives in the caller). */
  gate: GovernanceGate
  onLog?: (line: string) => void
  onError?: (msg: string) => void
  onPhase?: (p: 'signing' | 'signed') => void
  onWhat?: (w: { zec: string; addr: string } | null) => void
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
}

export class BackgroundSession {
  private readonly seats: SigningSeats
  private readonly signer: BackgroundSigner
  private readonly send: (data: string) => Promise<boolean>
  private readonly threshold: () => number
  private readonly onArmed?: (seats: number[], triggerTag: string | null) => void
  private readonly now: () => number
  private readonly onFailed?: (code: FailureCode) => void
  /** Seat -> the tag that armed it, for `currentProposal`. Keyed by SEAT so a device that reloads
   *  (new tag, same seat) replaces its own arming instead of counting twice. */
  private readonly armed = new Map<number, string>()
  /** The payment whose signatures this session is counting. Anything else is ignored.
   *
   *  The signing room is PERMANENT (it is derived from the group key), so its log still holds every
   *  earlier payment's signatures, and a device joining replays the whole thing from seq 0. Without
   *  this scope, the last payment's two signatures rebuilt a full quorum for a payment that had
   *  already been sent - the panel then showed "2 of 2 signed" for a payroll nobody had signed, and
   *  never offered the button to sign it. */
  private currentProposal: string | null = null

  constructor(deps: BackgroundSessionDeps) {
    this.send = deps.send
    this.threshold = deps.threshold
    this.onArmed = deps.onArmed
    this.now = deps.now ?? (() => Date.now())
    this.onFailed = deps.onFailed
    this.seats = new SigningSeats(deps.myTag, deps.mySeat, deps.onSeatCount)
    this.signer = new BackgroundSigner({
      signingMaterial: deps.signingMaterial,
      seatOf: (tag) => this.seats.seatOf(tag),
      mySeat: () => this.seats.mySeat(),
      threshold: deps.threshold,
      hasVault: () => true, // an unlocked, restored vault always exists
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

  /** Announce this device's seat on the signing room. Call once, right after opening the room. */
  async start(): Promise<void> {
    await this.send(JSON.stringify(this.seats.announcement()))
  }

  /** Pipe one relay message in. Routes `rejoin` to the seat table (then re-drives the signer, so a
   *  signing message that arrived before its sender was seated now proceeds); everything else goes
   *  to the signer. Call from RelaySession.onMessage. */
  async onMessage(from: string, data: string): Promise<void> {
    let parsed: { type?: string; seat?: number; proposal?: string; at?: number; code?: FailureCode } | null = null
    try {
      parsed = JSON.parse(data) as { type?: string; seat?: number; proposal?: string; at?: number; code?: FailureCode }
    } catch {
      /* not JSON - hand to the signer, which ignores unparseable input */
    }
    if (parsed?.type === 'unarmed' && typeof parsed.proposal === 'string') {
      if (parsed.proposal === this.currentProposal) {
        this.armed.clear()
        this.onArmed?.([], null)
        if (parsed.code) this.onFailed?.(parsed.code)
      }
      return
    }
    if (parsed?.type === 'armed' && typeof parsed.seat === 'number' && typeof parsed.proposal === 'string') {
      this.handleArmed(from, parsed.seat, parsed.proposal, typeof parsed.at === 'number' ? parsed.at : null)
      return
    }
    if (parsed?.type === 'rejoin' && typeof parsed.seat === 'number') {
      this.seats.handleRejoin(from, parsed.seat)
      await this.signer.retry() // a pending signing message may now know this sender's seat
      return
    }
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
   *  signature given for one payment can never count toward another. */
  setProposal(id: string | null): void {
    if (this.currentProposal === id) return
    this.currentProposal = id
    this.armed.clear()
    this.onArmed?.([], null)
  }

  /** Announce that this device's owner explicitly signed `proposal`. Every device (this one
   *  included, the relay echoes it back) sees the same ordered log and agrees on who sends. */
  async arm(proposal: string): Promise<void> {
    this.setProposal(proposal) // a no-op in the normal path; correct if the caller never scoped us
    const msg: ArmedMsg = { type: 'armed', seat: this.seats.mySeat(), proposal, at: this.now() }
    await this.send(JSON.stringify(msg))
  }

  /** Withdraw every signature for `proposal`: an attempt failed and nothing moved, so the payment
   *  goes back to unsigned on every device instead of looking signed by devices that have gone. */
  async unarm(proposal: string, code?: FailureCode): Promise<void> {
    const msg: UnarmedMsg = { type: 'unarmed', proposal, ...(code ? { code } : {}) }
    await this.send(JSON.stringify(msg))
  }

  /** Apply one signature. Signatures for any other payment are dropped, so replaying the room's
   *  history on join can never build a tally for the payment on screen. The device whose signature
   *  brings the tally exactly to the threshold is named as the sender - once, deterministically,
   *  from an ordering every device sees identically. */
  private handleArmed(from: string, seat: number, proposal: string, at: number | null): void {
    if (proposal !== this.currentProposal) return
    // A signature expires on the wire exactly as it expires on the device. Without this, a failed
    // attempt's signatures sat in the permanent room forever: on reload both devices rebuilt a full
    // quorum from tags that no longer existed, so the payment read as signed by ghosts and sendable
    // by nobody - no button, no sender, no way out. One with no timestamp is from before this rule
    // and is always stale; it can only be a leftover.
    if (at === null || !armIsLive(at, this.now())) return
    const known = this.armed.get(seat)
    this.armed.set(seat, from)
    const t = this.threshold()
    // Only a NEW seat can complete the quorum; a device re-announcing its own seat must not
    // re-fire the trigger.
    const completes = known === undefined && t > 0 && this.armed.size === t
    this.onArmed?.(this.armedSeats(), completes ? from : null)
  }

  /** The seats that have signed the current proposal, ascending. */
  armedSeats(): number[] {
    return [...this.armed.keys()].sort((a, b) => a - b)
  }

  /** Reset for a NEXT payment (the caller moves to a fresh signing room per payment). */
  rearm(): void {
    this.signer.rearm()
    this.armed.clear()
    this.currentProposal = null
  }
}
