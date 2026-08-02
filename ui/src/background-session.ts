// The app-level signing session (issue #49, Stage 3 wiring): what runs in the BACKGROUND while a
// member uses the Dashboard, so a send never sends them to /net. It composes the two extracted,
// tested pieces over ONE relay room (the vault's signing room):
//   • SigningSeats     — the rejoin/seating handshake (fixed seats from the DKG).
//   • BackgroundSigner — the FROST ceremony, gated by governance.
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
}

export class BackgroundSession {
  private readonly seats: SigningSeats
  private readonly signer: BackgroundSigner
  private readonly send: (data: string) => Promise<boolean>

  constructor(deps: BackgroundSessionDeps) {
    this.send = deps.send
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
    let parsed: { type?: string; seat?: number } | null = null
    try {
      parsed = JSON.parse(data) as { type?: string; seat?: number }
    } catch {
      /* not JSON — hand to the signer, which ignores unparseable input */
    }
    if (parsed?.type === 'rejoin' && typeof parsed.seat === 'number') {
      this.seats.handleRejoin(from, parsed.seat)
      await this.signer.retry() // a pending signing message may now know this sender's seat
      return
    }
    await this.signer.feed(from, data)
  }

  /** Re-drive the signer without new input — e.g. after the owner arms a manual-mode payment, so a
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

  /** Reset for a NEXT payment (the caller moves to a fresh signing room per payment). */
  rearm(): void {
    this.signer.rearm()
  }
}
