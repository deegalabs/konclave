// The FROST signing ceremony as a self-contained state machine, lifted verbatim out of
// NetVault (ADR-0006 Rung B, Stage 1 of the Dashboard-send convergence, issue #50). It owns
// ONLY the signing state (the per-spend ceremony: commitments -> signing package -> shares ->
// aggregate signature), driven by the relay messages `sreq | s1 | sp | s2 | signed`. The DKG,
// the roster/seating, and the relay transport stay in the caller; the machine reaches them
// through injected dependencies, and reports progress through injected callbacks.
//
// This is the SAME implementation the proven money path runs (a single source of truth), so the
// background signer and /net share it instead of forking. Behavior-preserving: every handler
// keeps the exact preconditions and the exact boolean return contract the caller's fixpoint
// relies on (`false` = "not ready, re-apply me later"; `true` = "consumed").

import { validBranch } from './signed-record'
import { Coordinator, identifierBytes, participantRound1, participantRound2WithRandomizer, readForSigning, pcztSighash } from './wasm-pkg/konclave_wasm.js'
import type { GateDecision, PcztOutput, PcztPayment } from './approved-payment'
import { b64, unb64, bytesEqual } from './net'
import { parseSignRequest, buildSignResponse, hexToBytes as hexBytes, bytesToHex, type SignRequest } from './net-sign'
import { parseAlphas } from './signing'

/** The signing-only subset of the /net wire protocol. `k` = the 0-based spend position in a
 *  multi-note tx (each real Orchard spend is its own ceremony; single-spend tx is always k=0). */
/** Which ceremony a message belongs to: the first 8 bytes of the transaction's ZIP-244 sighash, in
 *  hex. Every device derives it from ITS OWN PCZT (the same value H1 already binds to), so it needs
 *  no new trust and no coordination - two devices working on the same transaction always agree, and
 *  two working on different ones never do.
 *
 *  `k` already scopes messages to a spend WITHIN one transaction. `h` scopes them to the
 *  transaction, which `k` cannot: the signing room is permanent per vault, so two payments signed
 *  around the same time put their `s1`/`sp`/`s2` into one stream with nothing to tell them apart.
 *
 *  Optional on the wire so a device on an older cached build is not cut off mid-rollout: a message
 *  with no `h` is accepted, only a MISMATCHED one is dropped. */
export type CeremonyTag = { h?: string }

export type SignWireMsg =
  // `pczt` is OMITTED for a sealed request (#63): every device already holds the PCZT from the
  // sealed helper request, so re-broadcasting it would leak the payment to the relay. A plaintext
  // (compat) request still carries it inline for a device that has not opened one.
  | { type: 'sreq'; msg: string; pczt?: string }
  | ({ type: 's1'; commit: string; k: number } & CeremonyTag)
  | ({ type: 'sp'; signers: number[]; sp: string; msg: string; k: number } & CeremonyTag)
  | ({ type: 's2'; share: string; k: number } & CeremonyTag)
  | ({ type: 'signed'; sig: string; ok: boolean; k: number } & CeremonyTag)

/** This device's signing material (from a live DKG session OR a restored vault). */
export interface SigningMaterial {
  keyPackage: Uint8Array
  groupVk: Uint8Array
  pubkeys: Uint8Array
}

/** Everything the machine needs from its host: read-only lookups, the relay send, and the
 *  progress callbacks. Injected so the machine is pure of React and unit-testable. */
export interface SigningDeps {
  /** This device's signing bytes (KeyPackage + group PublicKeyPackage + pubkeys). */
  signingMaterial: () => SigningMaterial
  /** 1-based seat of a relay tag, or undefined if not seated yet. */
  seatOf: (tag: string) => number | undefined
  /** Did this tag PROVE it holds its seat's share (#392)? The coordinator prefers proven seats when
   *  it picks the threshold set (#399).
   *
   *  Required rather than optional, for the reason #281 made `decideApproval` required: there
   *  are two ceremony drivers here and they have diverged three times (#424, #425, #363). A driver
   *  that cannot tell proven from unproven must SAY so by answering false, not by omitting the
   *  question. Answering false everywhere restores the old lowest-seats behaviour exactly. */
  seatIsProven: (tag: string) => boolean
  /** This device's own 1-based seat (0 = unseated). */
  mySeat: () => number
  /** This device's own relay tag. */
  myTag: () => string
  /** The tag that coordinates the ceremony, or null while it is not known (SIGNER-SEAT1). The
   *  background session answers with the device whose signature completed the quorum, the same
   *  decision that names who sends; `/net` answers with its own rule. REQUIRED for the reason
   *  `decideApproval` is: two drivers, and each states its answer at its construction site. */
  coordinatorTag: () => string | null
  /** The quorum threshold `t`. */
  threshold: () => number
  /** True once this device holds a usable vault (DKG part 3 done, or restored). */
  hasVault: () => boolean
  /** Send a typed signing message over the relay (JSON inside the opaque `data`). */
  send: (m: SignWireMsg) => Promise<void>
  /** Send a RAW string over the relay (Architecture-B response back to the helper). */
  rawSend: (data: string) => Promise<boolean>
  onLog: (line: string) => void
  onError: (msg: string) => void
  onPhase: (p: 'signing' | 'signed') => void
  onWhat: (w: SignPreview | null) => void
  /** Does this PCZT pay EXACTLY what the quorum approved (#281)? `match` signs; `mismatch` and
   *  `unknown` (this device could not work out what was approved) refuse, each with its own words.
   *
   *  Called once per ceremony, right after the local sighash check and BEFORE any share is
   *  contributed. Refusing aborts: the device signs nothing and says so.
   *
   *  REQUIRED, not optional, on purpose. An optional check is one a caller forgets, and there are
   *  two ceremony drivers in this codebase - the background signer and `/net` - which have now
   *  diverged three times (#424, #425, #363) because a rule existed in one and not the other.
   *  Making every construction site supply it turns "did you remember?" into a compile error. */
  decideApproval: (outputs: PcztOutput[]) => GateDecision
  /** The owner's consent claims this transaction (its sighash in hex, derived by this device), after
   *  every other check and before any share moves. False refuses: the consent covers another
   *  transaction. REQUIRED for the same reason as `decideApproval`: each driver states its answer at
   *  its construction site. */
  claim: (sighashHex: string, expiry: number) => boolean | Promise<boolean>
  /** Record that this device's share goes into the transaction (its sighash, derived here, and the
   *  block it expires at and the consensus branch it is under, both from this device's own reading),
   *  written ONCE, just before the first share leaves: a ceremony that stalls
   *  in round 1 leaves no record. A record that cannot be written lets no share leave. REQUIRED for
   *  the same reason as `claim`. */
  record: (sighashHex: string, expiry: number, branch: number) => Promise<void>
  onSignature: (hex: string, ok: boolean) => void
  /** i18n lookup for log/error strings (net.log.* / net.err.*). */
  tt: (key: string, params?: Record<string, string | number>) => string
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
const shortId = (s: string) => (s.length > 24 ? `${s.slice(0, 14)}…${s.slice(-6)}` : s)
const fmtZec = (zat: number) => (zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')

/** What the signing screen shows: every output that moves value and the fee, as THIS device read
 *  them from the transaction it signs (#610), in zatoshis. `addr` is the output's address label,
 *  which the WASM refuses when it names a receiver the output does not pay. A missing label says
 *  nothing about where the money goes, so `recipient` rides along and the screen decides what to
 *  call an unlabelled output from it (device-reading.ts), never from the missing label. */
export interface SignPreview {
  outputs: { zat: number; addr: string | null; recipient: string | null }[]
  feeZat: number
}

function previewOf(p: PcztPayment): SignPreview {
  return {
    outputs: p.outputs
      .filter((o) => (o.value ?? 0) > 0)
      .map((o) => ({ zat: o.value ?? 0, addr: o.address, recipient: o.recipient })),
    feeZat: p.feeZat,
  }
}

/** Which refusal to show for a `readPayment` error. The WASM starts each refusal with a bracketed
 *  code; anything else is a PCZT the device could not read at all. */
export function refusalKey(e: unknown): string {
  const code = /^\[(\w+)\]/.exec(String(e).replace(/^Error:\s*/, ''))?.[1]
  switch (code) {
    case 'fee':
      return 'net.err.feeTooHigh'
    case 'commitment':
    case 'undecryptable':
      return 'net.err.outputMismatch'
    case 'label':
      return 'net.err.labelMismatch'
    case 'shape':
    case 'dummy':
      return 'net.err.unexpectedShape'
    case 'expiry':
      return 'net.err.expiry'
    case 'network':
      return 'net.err.network'
    case 'locktime':
      return 'net.err.locktime'
    case 'record':
      return 'net.err.recordFailed'
    default:
      return 'net.err.unreadablePczt'
  }
}

export class SigningMachine {
  private readonly d: SigningDeps

  // --- per-session signing state (was the sign* refs in NetVault) ---
  private started = false
  private msg: Uint8Array = new Uint8Array()
  private nonces: Uint8Array | null = null
  private commits = new Map<number, Uint8Array>()
  /** Seats whose committing tag proved it holds that seat's share (#399). Reset wherever `commits`
   *  is, or a seat proven in one ceremony would still count as proven in the next. */
  private provenSeats = new Set<number>()
  private deferredForProof = false
  private coord: Coordinator | null = null
  private spSent = false
  private sp: Uint8Array | null = null
  // The Orchard randomizer (alpha) of the spend being signed right now, read from the PCZT.
  private alpha: Uint8Array | null = null
  private sentS2 = false
  private sharesSeen = new Set<number>()
  /** The seats the signing package names: only they can have a share that belongs to this
   *  signature. And the seats already told to the member as refused, so a seat that keeps sending
   *  bad shares is said once. */
  private chosenSeats: number[] = []
  private toldAside = new Set<number>()
  private sigDone = false
  // Architecture B: a helper's raw sign-request; the aggregate signature is posted back to it RAW.
  private helperReq: SignRequest | null = null
  // Multi-spend: every real spend (index + alpha), driven SEQUENTIALLY, one ceremony each.
  private spends: { index: number; alpha: Uint8Array }[] = []
  private cur = 0 // 0-based position of the spend being signed right now
  private sigs: { index: number; sig: string }[] = [] // accumulated per-spend signatures
  private startedSpends = new Set<number>() // beginSpend fires once per position
  private done = false // the whole ceremony (every spend) finished
  /** Did the gate pass for THIS transaction? Set in one place, after every check in `onSreq`, and
   *  asked by every path that commits, shares, aggregates or advances (#610).
   *
   *  `onSreq` marks the ceremony started and loads its spends before the gate decides, and a refusal
   *  used to leave that state armed: a `signed` posted by anyone then moved a refusing device on to
   *  the next spend of the very transaction it had refused, and it signed the rest. The decision has
   *  to live inside the steps that produce a signature, not beside them (the lesson of #579). */
  private cleared = false
  /** The expiry this device read for the transaction. */
  private expiry = 0
  /** The consensus branch of the header this device read and checked, with `expiry`. */
  private branch = 0
  /** The coordinator of THIS ceremony, fixed where the gate clears it and kept until `rearm`. Read
   *  live, a withdrawal by any seat (one that never signed included) resets the room's tally and with
   *  it who the room names, so a member who did not sign could stall a send already under way. */
  private coordinator: string | null = null

  constructor(deps: SigningDeps) {
    this.d = deps
  }

  /** Who coordinates: assembles the SigningPackage, aggregates the shares, posts the signatures back.
   *
   *  Asked in one place, because it is read by the device deciding it should coordinate and by the
   *  device deciding whether to believe a package or a signature it was sent, and those two answering
   *  differently is exactly #519. It used to be seat 1, which acts only after its owner signs, so a
   *  vault whose seat 1 was away or had not signed could never send (SIGNER-SEAT1). It is now the
   *  device whose signature completed the quorum: live by construction, since it is the one asking
   *  for the send, and named alike by every device from the room's order. Before the gate clears a
   *  ceremony it is the room's current answer; after, the one fixed for the ceremony. */
  private isCoordinator(tag: string): boolean {
    const c = this.coordinatorNow()
    return c !== null && c === tag
  }

  /** The tag `isCoordinator` compares with: the one fixed for the ceremony, or, before one starts,
   *  the room's current answer (null while no quorum has completed). */
  private coordinatorNow(): string | null {
    return this.coordinator ?? (this.started ? null : this.d.coordinatorTag())
  }

  /** True once the current ceremony has fully finished (every spend signed). A long-lived signer
   *  (the background service, Stage 3) polls this to know when it may `rearm()` for a next payment. */
  isDone(): boolean {
    return this.done
  }

  /** Reset all ceremony state so this SAME machine can sign a NEXT payment (issue #49 re-arm). NOT
   *  called by /net (which signs once per session, so its behavior is unchanged); the background
   *  signer calls it between payments, each in its OWN fresh signing room - never re-armed inside a
   *  room whose relay history still holds the previous ceremony's `k`-tagged messages, which would
   *  cross-contaminate. Fresh session per payment is the contract. */
  rearm(): void {
    this.started = false
    this.cleared = false
    this.expiry = 0
    this.branch = 0
    this.coordinator = null
    this.done = false
    this.msg = new Uint8Array()
    this.nonces = null
    this.commits = new Map()
    this.provenSeats = new Set()
    this.deferredForProof = false
    this.coord = null
    this.spSent = false
    this.sp = null
    this.alpha = null
    this.sentS2 = false
    this.sharesSeen = new Set()
    this.chosenSeats = []
    this.toldAside = new Set()
    this.sigDone = false
    this.helperReq = null
    this.spends = []
    this.cur = 0
    this.sigs = []
    this.startedSpends = new Set()
  }

  /** Architecture B: detect a helper's raw sign-request BEFORE the typed dispatch. Returns true if
   *  the message was a sign-request (handled); false if it is not one (caller keeps dispatching). */
  async tryHelperRequest(rawData: string): Promise<boolean> {
    const helperReq = parseSignRequest(rawData)
    if (!helperReq) return false
    this.helperReq = helperReq
    // Nobody is named yet (the completing signature has not reached this device): the request waits,
    // unconsumed, and the session re-drives the signer when a signature changes the tally.
    if (this.coordinatorNow() === null) return false
    // The coordinator kicks the ceremony over the helper's real PCZT. `sreq` carries the sighash +
    // PCZT; each device reads ALL real spends' alphas from that PCZT and signs them one ceremony at a
    // time, so single- and multi-note transactions take the same path.
    if (this.isCoordinator(this.d.myTag()) && !this.sigDone && helperReq.spends.length >= 1) {
      await this.d.send({
        type: 'sreq',
        msg: b64(hexBytes(helperReq.sighash)),
        // A sealed request means every device registered and opened it, so each already holds the
        // PCZT: omit it here or it leaks the payment to the relay (#63). A plaintext (compat)
        // request still carries it inline for an older device that only reads the sreq.
        ...(helperReq.sealed ? {} : { pczt: b64(hexBytes(helperReq.pcztHex)) }),
      })
    }
    return true
  }

  /** Dispatch one signing message. Preserves NetVault's exact boolean contract for the fixpoint.
   *  May throw on a malformed peer package - the caller keeps its try/catch around this call. */
  async handle(parsed: SignWireMsg, fromTag: string): Promise<boolean> {
    // A transaction this device took up and refused is over here: every later message about it is
    // consumed and answered with nothing, not even an error. A forged package used to make a refused
    // device report `notCoordinator`, which replaced the refusal on screen (#610 review). While this
    // guard stands, the per-handler `cleared` checks below cannot be reached; they stay as defence in
    // depth, so a refactor that moves this line still leaves each step that signs asking on its own.
    if (this.started && !this.cleared) return true
    switch (parsed.type) {
      case 'sreq': return this.onSreq(parsed)
      case 's1': return this.onS1(parsed, fromTag)
      case 'sp': return this.onSp(parsed, fromTag)
      case 's2': return this.onS2(parsed, fromTag)
      case 'signed': return this.onSigned(parsed, fromTag)
    }
  }

  /** Start (or advance to) the ceremony for spend position `k`: reset the per-round state, pick that
   *  spend's alpha, generate FRESH nonces (never reused across signatures), and broadcast this
   *  device's commitment tagged with `k`. Fires once per position (guarded), on every device. */
  async beginSpend(k: number): Promise<void> {
    if (!this.cleared) return // nothing is committed for a transaction this device did not clear
    if (this.startedSpends.has(k)) return
    this.startedSpends.add(k)
    this.cur = k
    this.alpha = this.spends[k]?.alpha ?? null
    this.commits = new Map()
    this.provenSeats = new Set()
    this.deferredForProof = false
    this.spSent = false
    this.sp = null
    this.sentS2 = false
    this.sharesSeen = new Set()
    this.chosenSeats = []
    this.toldAside = new Set()
    this.sigDone = false
    this.coord = null
    const r1 = participantRound1(this.d.signingMaterial().keyPackage)
    this.nonces = r1.nonces()
    await this.d.send({ type: 's1', commit: b64(r1.commitment()), k, h: this.tag() })
    const n = this.spends.length
    this.d.onLog(n > 1 ? `~ signing spend ${k + 1}/${n}` : this.d.tt('net.log.signCommit'))
  }

  private async onSreq(parsed: Extract<SignWireMsg, { type: 'sreq' }>): Promise<boolean> {
    if (!this.d.hasVault()) return false // no vault yet
    if (!this.started) {
      // The ceremony needs a coordinator every device agrees on; until the completing signature reaches
      // this device, the request waits (unconsumed) rather than starting a ceremony nobody can finish.
      const coordinator = this.coordinatorNow()
      if (coordinator === null) return false
      // The PCZT to sign: from the sreq inline (an older, plaintext coordinator), or - for a sealed
      // request where the coordinator omitted it so it never touches the relay (#63) - the PCZT this
      // device already opened from the helper request. If neither is available yet, wait.
      const pczt = parsed.pczt
        ? unb64(parsed.pczt)
        : this.helperReq
          ? hexBytes(this.helperReq.pcztHex)
          : null
      if (!pczt) return false
      // H1 / ADR-0007 I2 (transaction-swap defense): recompute the ZIP-244 sighash from OUR OWN
      // PCZT and sign THAT, refusing if it disagrees with the requested one. A hostile helper or
      // coordinator can otherwise display a benign PCZT while the wire `sighash` targets an
      // attacker output; binding the signed message to the local PCZT makes that impossible.
      let localSighash: Uint8Array
      try {
        localSighash = pcztSighash(pczt)
      } catch (e) {
        this.d.onError(this.d.tt('net.err.sighashMismatch') + ' ' + String(e))
        return true
      }
      if (!bytesEqual(localSighash, unb64(parsed.msg))) {
        this.d.onError(this.d.tt('net.err.sighashMismatch'))
        return true
      }
      this.started = true
      this.msg = localSighash // sign what our own PCZT commits to, never the wire value
      // Every device reads ALL real spends (index + alpha) from the proven PCZT it holds - it signs
      // only what it can independently see. One ceremony per spend, in order.
      //
      // This is wrapped because #364 gave it a reason to THROW that it did not have before. It used
      // to answer the pool question itself and, on a transaction spending from both pools, quietly
      // return only the Orchard half. Now it refuses. Unwrapped, that refusal would travel up
      // through `pump()` (try/finally, no catch) and out of the relay subscription as an unhandled
      // rejection: the member would see nothing at all, which trades a wrong signature for a silent
      // stall. The engine's own sentence is appended because "which transaction, and why" is the
      // whole value of the refusal.
      try {
        this.spends = parseAlphas(pczt)
      } catch (e) {
        this.d.onError(this.d.tt('net.err.unreadableSpends') + ' ' + String(e))
        return true
      }
      this.sigs = []
      this.startedSpends = new Set()
      // What does this transaction actually pay? Read it ONCE and use the reading for both jobs:
      // the money gate's decision (#281) and the human preview.
      //
      // This used to be display-only, inside a catch that let the ceremony run when the PCZT could
      // not be read. That is the wrong default on a money path: a device that cannot see what it
      // signs cannot confirm it is the approved payment, and "show no preview, sign anyway" is
      // precisely the state where only human vigilance stood between a swapped destination and a
      // signature. It fails closed.
      //
      // `readPayment` is also where the reading became trustworthy (#610). It checks every output
      // against the note commitment the sighash covers, the address label against the receiver it
      // pays, opens each paying output for its memo, and bounds the fee by ZIP 317. Before it, the
      // device read the outputs as the builder wrote them, beside the commitment and not bound to
      // it, and nothing looked at the fee at all.
      // A reading belongs to one transaction. Cleared first, so a refusal of this one is never
      // shown over the reading of the payment before it.
      this.d.onWhat(null)
      // `readForSigning` (#610's reading plus what the device confirms about the transaction itself:
      // its network, that nothing delays it, and that it expires inside the window this device's own
      // clock allows, so it cannot be held signed and broadcast much later) is the one reading.
      let payment: PcztPayment
      try {
        payment = JSON.parse(readForSigning(pczt)) as PcztPayment
      } catch (e) {
        this.d.onError(this.d.tt(refusalKey(e)))
        this.d.onLog(`~ ${String(e)}`)
        return true
      }
      // Shown before the gate decides, so a refusal can show the payment it refused: the member is
      // told to compare it with the proposal, and has to be able to see it to do that.
      const preview = previewOf(payment)
      this.d.onWhat(preview)
      for (const o of preview.outputs) this.d.onLog(`~ ${fmtZec(o.zat)} ZEC -> ${o.addr ? shortId(o.addr) : 'no label'}`)
      this.d.onLog(`~ fee ${fmtZec(preview.feeZat)} ZEC`)
      // The gate, before any share moves. H1 proved this device signs the sighash of the PCZT it
      // holds; this proves that PCZT pays what the quorum approved. Both are needed: without the
      // first a hostile coordinator swaps the bytes under the signature, without the second it
      // swaps the payment under the approval.
      // Anything but `match` refuses. The two refusals are worded apart because they ask different
      // things of the member: a mismatch is evidence to tell the others about, an approval this device
      // could not load is a reason to reload first (#610 review).
      const decision = this.d.decideApproval(payment.outputs)
      if (decision !== 'match') {
        this.d.onError(this.d.tt(decision === 'unknown' ? 'net.err.approvalUnknown' : 'net.err.notApproved'))
        return true
      }
      // The owner's consent covers one transaction: the first one cleared under it.
      // The expiry and the branch are THIS device's reading of the header it just checked, never a
      // field of the request: the record keeps what the device saw, not what it was told.
      const read = payment as PcztPayment & { expiry: number; branch: number }
      // A reading with no usable branch is not recorded under a default: nothing is signed.
      if (!validBranch(read.branch)) {
        this.d.onError(this.d.tt(refusalKey('[record]')))
        this.d.onLog('~ [record] the reading carries no usable consensus branch')
        return true
      }
      this.expiry = read.expiry
      this.branch = read.branch
      let claimed: boolean
      try {
        claimed = await this.d.claim(bytesToHex(this.msg!), this.expiry)
      } catch (e) {
        // This device could not read what it signed before: final, and said as it is.
        this.d.onError(this.d.tt('net.err.recordUnreadable'))
        this.d.onLog(`~ ${String(e)}`)
        return true
      }
      if (!claimed) {
        this.d.onError(this.d.tt('net.err.signedAnother'))
        // The one refusal its owner can answer: every check above passed, and only their signature
        // is missing. So the request stays pending, not consumed, and the ceremony is not started:
        // when they sign again, the next pass reads it afresh and runs every check again, the claim
        // included. Without this, "Sign again" in the same session armed a device that could no
        // longer sign, because the request it answers had already been used up here.
        this.started = false
        return false
      }
      this.cleared = true // every check above passed, and only here
      this.coordinator = coordinator // fixed for this ceremony (review I1)
      this.d.onPhase('signing')
      await this.beginSpend(0) // the first (and, for a single-spend tx, the only) ceremony
    }
    return true
  }

  /** This ceremony's tag: the first 8 bytes of the sighash THIS device derived from its own PCZT. */
  private tag(): string | undefined {
    if (this.msg.length < 8) return undefined
    return Array.from(this.msg.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** True when a message belongs to a DIFFERENT transaction than the one being signed here. An
   *  absent tag is from a build that predates this rule and is let through; only a tag that
   *  disagrees is refused. */
  private otherCeremony(m: CeremonyTag): boolean {
    const mine = this.tag()
    return mine !== undefined && m.h !== undefined && m.h !== mine
  }

  private async onS1(parsed: Extract<SignWireMsg, { type: 's1' }>, fromTag: string): Promise<boolean> {
    if (!this.started) return false
    if (!this.cleared) return true // refused here: this device does not help sign it
    if (this.otherCeremony(parsed)) return true // another transaction's round 1 - never mix it in
    // Spend-tagged: a message for a LATER spend waits (re-applied after we advance); an EARLIER
    // one is stale and dropped. Keeps N sequential ceremonies from crossing over the relay.
    if (parsed.k !== this.cur) return parsed.k > this.cur ? false : true
    const seat = this.d.seatOf(fromTag)
    if (seat === undefined) return false
    this.commits.set(seat, unb64(parsed.commit))
    // Proven-ness belongs to the TAG and this set is keyed by seat, so record it here while both are
    // in hand. A later commit for the same seat from a different tag overwrites: the seat's standing
    // follows whoever last committed for it.
    if (this.d.seatIsProven(fromTag)) this.provenSeats.add(seat)
    else this.provenSeats.delete(seat)
    await this.coordinateIfReady()
    return true
  }

  /** Called by the driver when a drain has nothing left to process (#399).
   *
   *  The one thing the fixpoint loop cannot do on its own: a coordinator that deferred to look for a
   *  proven seat has consumed its message, so no retry is scheduled by the loop itself. This is that
   *  retry, and it runs exactly once per drain rather than per message.
   *
   *  Safe to call at any time: `coordinateIfReady` re-checks every precondition, and `spSent` makes
   *  it idempotent. */
  async afterDrain(): Promise<void> {
    if (!this.started) return
    await this.coordinateIfReady()
  }

  /** Build and broadcast the SigningPackage once this device (the coordinator) holds enough commitments.
   *
   *  Split out of `onS1` so `afterDrain` can run it again (#399). The deferral inside CONSUMES its
   *  message rather than returning it unread, so something else has to retry - and it cannot be
   *  another `s1`, because the commitment that reaches threshold usually arrives alone and the
   *  driver's fixpoint loop then exits with nothing left to progress. */
  private async coordinateIfReady(): Promise<void> {
    const t = this.d.threshold()
    if (this.isCoordinator(this.d.myTag()) && this.commits.size >= t && !this.spSent) {
      // Prefer PROVEN seats, falling back to unproven only to reach threshold (#399).
      //
      // THIS FIRES. It did not when the sort was first written, and the comment that said so
      // outlived the fix by long enough to be worth calling out: for a while this block described a
      // live security control as inert groundwork, which is the kind of note that makes a reader
      // conclude the wrong thing about what is protecting them.
      //
      // What changed is the deferral below plus `afterDrain()` (#515). The coordinator used to pick
      // on the t-th commit it PROCESSED, so a proven seat arriving later in the same drain was not
      // in `commits` when this ran and the sort was over a set already decided. Now, when the set it
      // would pick still needs an unvouched seat, it defers once and `afterDrain` re-drives it after
      // the whole drain has landed, so the sort runs over the complete batch.
      //
      // This used to be the lowest `t` seats, full stop. An unproven rejoin may still take a truly
      // EMPTY seat - deliberately, so older builds keep working - so in a `t < n` vault with a low
      // seat offline, an outsider could take that seat, post a bogus commitment, and be chosen
      // simply for being low. The aggregate then references a commitment no share made, the
      // signature does not verify, and the send fails. No funds move: the ceremony dies, which is
      // the whole of the attack.
      //
      // Preference and not exclusion, because excluding unproven seats outright would stop a vault
      // whose members run an older build from signing at all. When every committing seat is proven,
      // this picks exactly what it picked before.
      // Defer ONCE if the set we would pick still needs an unproven seat (#399).
      //
      // Consumed, not returned false. Returning it unconsumed relies on ANOTHER message progressing
      // in the same drain to trigger a retry - and the t-th commit usually arrives alone, so the
      // loop exits and the ceremony dies waiting. `afterDrain()` is what actually retries, and the
      // drivers call it when there is nothing left to process.
      //
      // Bounded at one deferral, deliberately: a vault whose members all run a build that does not
      // sign its rejoin has NO proven seats and must still be able to sign.
      const provenNow = [...this.commits.keys()].filter((x) => this.provenSeats.has(x)).length
      if (provenNow < t && !this.deferredForProof) {
        this.deferredForProof = true
        return // `afterDrain` picks this up once the rest of the drain has landed
      }
      const committed = [...this.commits.keys()].sort((a, b) => a - b)
      const chosen = [
        ...committed.filter((x) => this.provenSeats.has(x)),
        ...committed.filter((x) => !this.provenSeats.has(x)),
      ]
        .slice(0, t)
        .sort((a, b) => a - b)
      const mat = this.d.signingMaterial()
      const coord = new Coordinator(mat.groupVk, mat.pubkeys, this.msg)
      for (const s of chosen) coord.addCommitment(identifierBytes(s), this.commits.get(s)!)
      coord.prepare()
      this.coord = coord
      this.chosenSeats = chosen
      this.sp = coord.signingPackage()
      this.spSent = true
      await this.d.send({ type: 'sp', signers: chosen, sp: b64(this.sp), msg: b64(this.msg), k: this.cur, h: this.tag() })
      this.d.onLog(this.d.tt('net.log.signCoord', { seats: chosen.join(', ') }))
    }
  }

  private async onSp(parsed: Extract<SignWireMsg, { type: 'sp' }>, fromTag: string): Promise<boolean> {
    // Only the coordinator may open round 2 (#519).
    //
    // `handle` hands `fromTag` to every other handler and used to drop it here, so the checks below
    // asked what the package contained and never who sent it. The round-1 commitments are public in
    // the room, so anyone who can write to it could assemble a well-formed package over the LIVE
    // commitments and post it - frost-core's own IncorrectCommitment check does not help, because
    // the commitments are the real ones. Every device would then spend its single-use nonce on that
    // package, `sentS2` would block a second share, and the honest coordinator would arrive to a
    // device with nothing left to give.
    //
    // Not theft: #355 already refuses a `msg` this device did not derive from its own PCZT, so the
    // transaction stays the approved one. What it costs is the ceremony.
    //
    // The coordinator is asked by the same method `coordinateIfReady` uses to decide who coordinates,
    // so this asks the one question that was missing rather than adding a second notion of who is in
    // charge. It is the tag fixed for this ceremony, not a seat: a second tab of the coordinator's own
    // seat is not the coordinator (SIGNER-SEAT1).
    // NOT-YET-SEATED IS NOT THE SAME AS NOT-THE-COORDINATOR, and conflating the two would trade this
    // hole for an outage. `seatOf` is fed by the peer's `rejoin`, not by its `s1`, so a legitimate
    // coordinator's package can land before this device has processed the rejoin that seats it.
    // `onS1` already answers that with `return false` - unconsumed, and `background-session` re-drives
    // the signer after every rejoin precisely so a message that arrived before its sender was seated
    // proceeds. Refusing here instead would consume the package and drop the honest send for good.
    // Nothing to answer before this device read a request: a package now waits, unread, and above
    // all says nothing over a refusal its owner can still answer (that refusal leaves the ceremony
    // unstarted).
    if (!this.started) return false
    if (!this.isCoordinator(fromTag)) {
      if (this.d.seatOf(fromTag) === undefined) return false
      this.d.onError(this.d.tt('net.err.notCoordinator'))
      return true
    }
    if (!this.cleared) return true // refused here: no share for it, whoever asks
    if (this.otherCeremony(parsed)) return true
    if (parsed.k !== this.cur) return parsed.k > this.cur ? false : true
    // The package this device assembled is the one it knows: one that is not the package it sent
    // is not read.
    if (fromTag === this.d.myTag() && this.sp && !bytesEqual(unb64(parsed.sp), this.sp)) return true
    // H1 / ADR-0007, the second half. `onSreq` recomputes the ZIP-244 sighash from THIS device's own
    // PCZT and refuses a request that disagrees - and this line used to hand that back, overwriting
    // the locally derived sighash with whatever the coordinator put on the wire, unchecked. The
    // share is then computed over the coordinator's SigningPackage, so the device would display the
    // transaction it verified and sign the one it was handed. Refuse instead: the message this
    // device signs is the one its own PCZT commits to, in round 2 as much as in round 1.
    if (!bytesEqual(unb64(parsed.msg), this.msg)) {
      this.d.onError(this.d.tt('net.err.sighashMismatch'))
      return true
    }
    // The line above checks a CLAIM. `msg` and `sp` are two independent fields, and the share is
    // computed over the message inside `sp`: a coordinator that leaves `msg` honest and builds the
    // package over a transaction of its own used to get a share from this device, over a message
    // it never derived and never showed its owner. So the message is handed to the function that
    // signs, which refuses a package that signs anything else. It cannot be skipped from here,
    // because there is no longer a way to ask for the share without it.
    const sp = unb64(parsed.sp)
    if (this.cleared && parsed.signers.includes(this.d.mySeat()) && !this.sentS2 && this.nonces && this.alpha) {
      // Before EVERY share, not once per ceremony: the record is also where the owner's consent is
      // asked again, so a package that arrives after they withdrew gets nothing (the store keeps
      // one entry per transaction however often it is asked).
      try {
        await this.d.record(bytesToHex(this.msg), this.expiry, this.branch)
      } catch (e) {
        // A withdrawn consent is the owner's own choice, already said on their screen and to the
        // room; anything else is a record this device could not keep.
        if (!String(e).includes('[withdrawn]')) this.d.onError(this.d.tt(refusalKey('[record]')))
        this.d.onLog(`~ ${String(e)}`)
        return true
      }
      let share: Uint8Array
      try {
        share = participantRound2WithRandomizer(
          sp,
          this.nonces,
          this.d.signingMaterial().keyPackage,
          this.alpha, // the current spend's alpha (set by beginSpend)
          this.msg, // what THIS device derived from its own PCZT, never the wire value
        )
      } catch (e) {
        // Reported, never thrown: `pump()` is try/finally with no catch (#364), so a throw here
        // would leave the member with nothing on screen. The engine's reason follows, because a
        // package over another message and a malformed package are different events.
        this.d.onError(this.d.tt('net.err.sighashMismatch') + ' ' + String(e))
        return true
      }
      this.sp = sp
      this.sentS2 = true
      await this.d.send({ type: 's2', share: b64(share), k: this.cur, h: this.tag() })
      this.d.onLog(this.d.tt('net.log.signShare'))
      // The coordinator takes its own share from here, not from the room's echo of it (`onS2`).
      if (this.coord && this.isCoordinator(this.d.myTag())) {
        this.coord.addShare(identifierBytes(this.d.mySeat()), share)
        this.sharesSeen.add(this.d.mySeat())
        await this.tryAggregate()
      }
    }
    return true
  }

  private async onS2(parsed: Extract<SignWireMsg, { type: 's2' }>, fromTag: string): Promise<boolean> {
    if (!this.started) return false
    if (!this.cleared) return true // refused here: nothing to aggregate
    if (this.otherCeremony(parsed)) return true
    if (!this.isCoordinator(this.d.myTag())) return true // only the coordinator aggregates
    if (parsed.k !== this.cur) return parsed.k > this.cur ? false : true
    if (!this.coord) return false
    const seat = this.d.seatOf(fromTag)
    if (seat === undefined) return false
    // This device's own share is the one it computed itself (`onSp`), never what the room says it
    // sent.
    if (seat === this.d.mySeat()) return true
    if (this.sharesSeen.has(seat)) return true
    // A share counts only from a seat the package names: any other cannot belong to this signature.
    if (!this.chosenSeats.includes(seat)) return true
    // A share counts only if it verifies on its own, for this seat, in this package, under this
    // spend's alpha. One that does not (or is not even a share: not base64, the wrong length)
    // is not counted, and the next share from that seat is checked in its turn.
    let share: Uint8Array
    try {
      if (typeof parsed.share !== 'string' || !this.alpha) return true
      share = unb64(parsed.share)
      this.coord.checkShare(identifierBytes(seat), share, this.alpha)
    } catch {
      if (!this.toldAside.has(seat)) {
        this.toldAside.add(seat)
        // The seat follows the key, as the other notices carry their detail: the background path
        // hands the key out untranslated and the screen words it (`describeSigningError`).
        this.d.onError(this.d.tt('net.err.badShare') + ' ' + seat)
      }
      return true
    }
    this.coord.addShare(identifierBytes(seat), share)
    this.sharesSeen.add(seat)
    await this.tryAggregate()
    return true
  }

  /** Put the shares together once there are enough. The count is closed (`sigDone`) only once an
   *  aggregate exists. */
  private async tryAggregate() {
    const coord = this.coord
    if (!coord || this.sigDone || !this.alpha || this.sharesSeen.size < this.d.threshold()) return
    let sig: Uint8Array
    let ok: boolean
    try {
      sig = coord.aggregateWithRandomizer(this.alpha)
      // A signature that does not verify is still announced with `ok: false`, as it always was:
      // every device checks it again under ak+alpha and records it only if it holds (`onSigned`).
      ok = coord.verifyWithRandomizer(this.alpha, sig)
    } catch (e) {
      // Every share was checked before it counted, so this is not a share a signer can be blamed
      // for. Nothing here would retry by itself: say so rather than sit silent.
      this.d.onError(this.d.tt('net.err.stepFailed') + ' ' + String(e))
      return
    }
    this.sigDone = true
    // Broadcast this spend's signature tagged with `k`; every device records it and either
    // advances to the next spend or finalizes (the `signed` handler). The Architecture B
    // response for the WHOLE set is posted once, at the last spend.
    await this.d.send({ type: 'signed', sig: b64(sig), ok, k: this.cur, h: this.tag() })
    this.d.onLog(this.d.tt('net.log.signAggregate'))
  }

  private async onSigned(parsed: Extract<SignWireMsg, { type: 'signed' }>, fromTag: string): Promise<boolean> {
    if (!this.started) return false
    if (!this.cleared) return true // refused here: a signature for it moves nothing
    if (this.otherCeremony(parsed)) return true
    // Only the coordinator aggregates, so only it may announce a spend signed (#610). As in `onSp`, a
    // sender not seated YET is not refused, only deferred.
    if (!this.isCoordinator(fromTag)) return this.d.seatOf(fromTag) === undefined ? false : true
    if (parsed.k !== this.cur) return parsed.k > this.cur ? false : true
    const sig = unb64(parsed.sig)
    // Every device re-checks under ak+alpha (a fresh Coordinator just to verify), and a signature
    // that does not verify here is neither recorded nor a reason to move on. It used to be both:
    // the coordinator's word was kept when the local check could not run.
    let ok = false
    try {
      if (this.alpha) {
        const mat = this.d.signingMaterial()
        ok = new Coordinator(mat.groupVk, mat.pubkeys, this.msg).verifyWithRandomizer(this.alpha, sig)
      }
    } catch {
      ok = false
    }
    if (!ok) {
      this.d.onLog(this.d.tt('net.log.verifyFail'))
      return true
    }
    // Record this spend's signature under its on-chain index (dedup - the fixpoint may retry).
    const spend = this.spends[this.cur]
    if (spend && !this.sigs.some((s) => s.index === spend.index)) {
      this.sigs.push({ index: spend.index, sig: bytesToHex(sig) })
    }
    const total = this.spends.length
    const isLast = this.cur >= total - 1
    if (!isLast) {
      // More spends to sign: every device advances to the next ceremony (fresh nonces, next alpha).
      this.d.onPhase('signing')
      await this.beginSpend(this.cur + 1)
      return true
    }
    // Last spend done: show the result and (Architecture B) hand the FULL set of signatures back
    // to the helper RAW so it can inject every one and broadcast.
    this.done = true // the whole ceremony finished; a re-armable signer may now take a next payment
    this.d.onSignature(hex(sig), ok)
    this.d.onPhase('signed')
    this.d.onLog(ok ? this.d.tt('net.log.verifyOk') : this.d.tt('net.log.verifyFail'))
    const req = this.helperReq
    if (req && this.isCoordinator(this.d.myTag()) && this.sigs.length === total) {
      const resp = buildSignResponse(this.sigs)
      await this.d.rawSend(resp)
      this.d.onLog(`-> ${total} signature(s) handed to the helper`)
      this.helperReq = null
    }
    return true
  }
}
