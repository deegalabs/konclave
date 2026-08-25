// The app-level signing session (issue #49, Stage 3 wiring): what runs in the BACKGROUND while a
// member uses the Dashboard, so a send never sends them to /net. It composes the two extracted,
// tested pieces over ONE relay room (the vault's signing room):
//   • SigningSeats     - the rejoin/seating handshake (fixed seats from the DKG).
//   • BackgroundSigner - the FROST ceremony, gated by governance.
// This module is the transport-agnostic core; the thin React layer only pipes a RelaySession's
// messages into `onMessage` and calls `start()`/`stop()`. Unit-tested end to end over an in-memory
// relay, so the live layer is glue, not logic.

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
}

/** A device announcing that its owner explicitly signed THIS proposal. Broadcast into the signing
 *  room so every device can see who has signed and agree, from one ordered log, on who sends. */
export interface ArmedMsg {
  type: 'armed'
  seat: number
  /** The proposal this arming is for, so a replayed arming from an older payment is ignored. */
  proposal: string
}

export class BackgroundSession {
  private readonly seats: SigningSeats
  private readonly signer: BackgroundSigner
  private readonly send: (data: string) => Promise<boolean>
  private readonly threshold: () => number
  private readonly onArmed?: (seats: number[], triggerTag: string | null) => void
  /** Seat -> the tag that armed it, for the proposal in `armedProposal`. Keyed by SEAT so a device
   *  that reloads (new tag, same seat) replaces its own arming instead of counting twice. */
  private readonly armed = new Map<number, string>()
  private armedProposal: string | null = null

  constructor(deps: BackgroundSessionDeps) {
    this.send = deps.send
    this.threshold = deps.threshold
    this.onArmed = deps.onArmed
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
    let parsed: { type?: string; seat?: number; proposal?: string } | null = null
    try {
      parsed = JSON.parse(data) as { type?: string; seat?: number; proposal?: string }
    } catch {
      /* not JSON - hand to the signer, which ignores unparseable input */
    }
    if (parsed?.type === 'armed' && typeof parsed.seat === 'number' && typeof parsed.proposal === 'string') {
      this.handleArmed(from, parsed.seat, parsed.proposal)
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

  /** Announce that this device's owner explicitly signed `proposal`. Every device (this one
   *  included, the relay echoes it back) sees the same ordered log and agrees on who sends. */
  async arm(proposal: string): Promise<void> {
    const msg: ArmedMsg = { type: 'armed', seat: this.seats.mySeat(), proposal }
    await this.send(JSON.stringify(msg))
  }

  /** Apply one arming. An arming for a DIFFERENT proposal starts a fresh tally, so a replayed
   *  arming from an older payment can never count toward this one. The device whose arming brings
   *  the tally exactly to the threshold is named as the trigger - once, deterministically, from an
   *  ordering every device sees identically. */
  private handleArmed(from: string, seat: number, proposal: string): void {
    if (this.armedProposal !== proposal) {
      this.armedProposal = proposal
      this.armed.clear()
    }
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
    this.armedProposal = null
  }
}
