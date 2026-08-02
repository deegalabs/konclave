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

import { Coordinator, identifierBytes, participantRound1, participantRound2WithRandomizer, describeOutputs, pcztSighash } from './wasm-pkg/konclave_wasm.js'
import { b64, unb64, bytesEqual } from './net'
import { parseSignRequest, buildSignResponse, hexToBytes as hexBytes, bytesToHex, type SignRequest } from './net-sign'
import { parseAlphas } from './signing'

/** The signing-only subset of the /net wire protocol. `k` = the 0-based spend position in a
 *  multi-note tx (each real Orchard spend is its own ceremony; single-spend tx is always k=0). */
export type SignWireMsg =
  | { type: 'sreq'; msg: string; pczt: string }
  | { type: 's1'; commit: string; k: number }
  | { type: 'sp'; signers: number[]; sp: string; msg: string; k: number }
  | { type: 's2'; share: string; k: number }
  | { type: 'signed'; sig: string; ok: boolean; k: number }

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
  /** This device's own 1-based seat (0 = unseated). */
  mySeat: () => number
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
  onWhat: (w: { zec: string; addr: string } | null) => void
  onSignature: (hex: string, ok: boolean) => void
  /** i18n lookup for log/error strings (net.log.* / net.err.*). */
  tt: (key: string, params?: Record<string, string | number>) => string
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
const shortId = (s: string) => (s.length > 24 ? `${s.slice(0, 14)}…${s.slice(-6)}` : s)
const fmtZec = (zat: number) => (zat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')

export class SigningMachine {
  private readonly d: SigningDeps

  // --- per-session signing state (was the sign* refs in NetVault) ---
  private started = false
  private msg: Uint8Array = new Uint8Array()
  private nonces: Uint8Array | null = null
  private commits = new Map<number, Uint8Array>()
  private coord: Coordinator | null = null
  private spSent = false
  private sp: Uint8Array | null = null
  // The Orchard randomizer (alpha) of the spend being signed right now, read from the PCZT.
  private alpha: Uint8Array | null = null
  private sentS2 = false
  private sharesSeen = new Set<number>()
  private sigDone = false
  // Architecture B: a helper's raw sign-request; the aggregate signature is posted back to it RAW.
  private helperReq: SignRequest | null = null
  // Multi-spend: every real spend (index + alpha), driven SEQUENTIALLY, one ceremony each.
  private spends: { index: number; alpha: Uint8Array }[] = []
  private cur = 0 // 0-based position of the spend being signed right now
  private sigs: { index: number; sig: string }[] = [] // accumulated per-spend signatures
  private startedSpends = new Set<number>() // beginSpend fires once per position
  private done = false // the whole ceremony (every spend) finished

  constructor(deps: SigningDeps) {
    this.d = deps
  }

  /** True once the current ceremony has fully finished (every spend signed). A long-lived signer
   *  (the background service, Stage 3) polls this to know when it may `rearm()` for a next payment. */
  isDone(): boolean {
    return this.done
  }

  /** Reset all ceremony state so this SAME machine can sign a NEXT payment (issue #49 re-arm). NOT
   *  called by /net (which signs once per session, so its behavior is unchanged); the background
   *  signer calls it between payments, each in its OWN fresh signing room — never re-armed inside a
   *  room whose relay history still holds the previous ceremony's `k`-tagged messages, which would
   *  cross-contaminate. Fresh session per payment is the contract. */
  rearm(): void {
    this.started = false
    this.done = false
    this.msg = new Uint8Array()
    this.nonces = null
    this.commits = new Map()
    this.coord = null
    this.spSent = false
    this.sp = null
    this.alpha = null
    this.sentS2 = false
    this.sharesSeen = new Set()
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
    // The coordinator (seat 1) kicks the ceremony over the helper's real PCZT. `sreq` carries the
    // sighash + PCZT; each device reads ALL real spends' alphas from that PCZT and signs them one
    // ceremony at a time, so single- and multi-note transactions take the same path.
    if (this.d.mySeat() === 1 && !this.sigDone && helperReq.spends.length >= 1) {
      await this.d.send({
        type: 'sreq',
        msg: b64(hexBytes(helperReq.sighash)),
        pczt: b64(hexBytes(helperReq.pcztHex)),
      })
    }
    return true
  }

  /** Dispatch one signing message. Preserves NetVault's exact boolean contract for the fixpoint.
   *  May throw on a malformed peer package — the caller keeps its try/catch around this call. */
  async handle(parsed: SignWireMsg, fromTag: string): Promise<boolean> {
    switch (parsed.type) {
      case 'sreq': return this.onSreq(parsed)
      case 's1': return this.onS1(parsed, fromTag)
      case 'sp': return this.onSp(parsed)
      case 's2': return this.onS2(parsed, fromTag)
      case 'signed': return this.onSigned(parsed)
    }
  }

  /** Start (or advance to) the ceremony for spend position `k`: reset the per-round state, pick that
   *  spend's alpha, generate FRESH nonces (never reused across signatures), and broadcast this
   *  device's commitment tagged with `k`. Fires once per position (guarded), on every device. */
  async beginSpend(k: number): Promise<void> {
    if (this.startedSpends.has(k)) return
    this.startedSpends.add(k)
    this.cur = k
    this.alpha = this.spends[k]?.alpha ?? null
    this.commits = new Map()
    this.spSent = false
    this.sp = null
    this.sentS2 = false
    this.sharesSeen = new Set()
    this.sigDone = false
    this.coord = null
    const r1 = participantRound1(this.d.signingMaterial().keyPackage)
    this.nonces = r1.nonces()
    await this.d.send({ type: 's1', commit: b64(r1.commitment()), k })
    const n = this.spends.length
    this.d.onLog(n > 1 ? `~ signing spend ${k + 1}/${n}` : this.d.tt('net.log.signCommit'))
  }

  private async onSreq(parsed: Extract<SignWireMsg, { type: 'sreq' }>): Promise<boolean> {
    if (!this.d.hasVault()) return false // no vault yet
    if (!this.started) {
      const pczt = unb64(parsed.pczt)
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
      // Every device reads ALL real Orchard spends (index + alpha) from the proven PCZT it holds
      // — it signs only what it can independently see. One ceremony per spend, in order.
      this.spends = parseAlphas(pczt)
      this.sigs = []
      this.startedSpends = new Set()
      // "What am I signing?" — confirm what the tx pays before contributing any signature.
      try {
        const outs = JSON.parse(describeOutputs(pczt)) as { address: string | null; value: number | null }[]
        const recip = outs.find((o) => o.address !== null)
        if (recip && recip.address && recip.value != null) {
          this.d.onWhat({ zec: fmtZec(recip.value), addr: recip.address })
          this.d.onLog(`~ ${fmtZec(recip.value)} ZEC -> ${shortId(recip.address)}`)
        }
      } catch {
        /* if the PCZT can't be read, the UI simply shows no preview; the ceremony still runs */
      }
      this.d.onPhase('signing')
      await this.beginSpend(0) // the first (and, for a single-spend tx, the only) ceremony
    }
    return true
  }

  private async onS1(parsed: Extract<SignWireMsg, { type: 's1' }>, fromTag: string): Promise<boolean> {
    if (!this.started) return false
    // Spend-tagged: a message for a LATER spend waits (re-applied after we advance); an EARLIER
    // one is stale and dropped. Keeps N sequential ceremonies from crossing over the relay.
    if (parsed.k !== this.cur) return parsed.k > this.cur ? false : true
    const seat = this.d.seatOf(fromTag)
    if (seat === undefined) return false
    this.commits.set(seat, unb64(parsed.commit))
    const t = this.d.threshold()
    if (this.d.mySeat() === 1 && this.commits.size >= t && !this.spSent) {
      const chosen = [...this.commits.keys()].sort((a, b) => a - b).slice(0, t)
      const mat = this.d.signingMaterial()
      const coord = new Coordinator(mat.groupVk, mat.pubkeys, this.msg)
      for (const s of chosen) coord.addCommitment(identifierBytes(s), this.commits.get(s)!)
      coord.prepare()
      this.coord = coord
      this.sp = coord.signingPackage()
      this.spSent = true
      await this.d.send({ type: 'sp', signers: chosen, sp: b64(this.sp), msg: b64(this.msg), k: this.cur })
      this.d.onLog(this.d.tt('net.log.signCoord', { seats: chosen.join(', ') }))
    }
    return true
  }

  private async onSp(parsed: Extract<SignWireMsg, { type: 'sp' }>): Promise<boolean> {
    if (!this.started) return false
    if (parsed.k !== this.cur) return parsed.k > this.cur ? false : true
    this.sp = unb64(parsed.sp)
    this.msg = unb64(parsed.msg)
    if (parsed.signers.includes(this.d.mySeat()) && !this.sentS2 && this.nonces && this.alpha) {
      const share = participantRound2WithRandomizer(
        this.sp,
        this.nonces,
        this.d.signingMaterial().keyPackage,
        this.alpha, // the current spend's alpha (set by beginSpend)
      )
      this.sentS2 = true
      await this.d.send({ type: 's2', share: b64(share), k: this.cur })
      this.d.onLog(this.d.tt('net.log.signShare'))
    }
    return true
  }

  private async onS2(parsed: Extract<SignWireMsg, { type: 's2' }>, fromTag: string): Promise<boolean> {
    if (!this.started) return false
    if (this.d.mySeat() !== 1) return true // only the coordinator aggregates
    if (parsed.k !== this.cur) return parsed.k > this.cur ? false : true
    if (!this.coord) return false
    const seat = this.d.seatOf(fromTag)
    if (seat === undefined) return false
    if (this.sharesSeen.has(seat)) return true
    this.coord.addShare(identifierBytes(seat), unb64(parsed.share))
    this.sharesSeen.add(seat)
    const t = this.d.threshold()
    if (this.sharesSeen.size >= t && !this.sigDone && this.alpha) {
      this.sigDone = true
      const sig = this.coord.aggregateWithRandomizer(this.alpha)
      const ok = this.coord.verifyWithRandomizer(this.alpha, sig)
      // Broadcast this spend's signature tagged with `k`; every device records it and either
      // advances to the next spend or finalizes (the `signed` handler). The Architecture B
      // response for the WHOLE set is posted once, at the last spend.
      await this.d.send({ type: 'signed', sig: b64(sig), ok, k: this.cur })
      this.d.onLog(this.d.tt('net.log.signAggregate'))
    }
    return true
  }

  private async onSigned(parsed: Extract<SignWireMsg, { type: 'signed' }>): Promise<boolean> {
    if (!this.started) return false
    if (parsed.k !== this.cur) return parsed.k > this.cur ? false : true
    const sig = unb64(parsed.sig)
    let ok = parsed.ok
    try {
      if (this.alpha) {
        // Every device re-checks under ak+alpha (a fresh Coordinator just to verify).
        const mat = this.d.signingMaterial()
        ok = new Coordinator(mat.groupVk, mat.pubkeys, this.msg).verifyWithRandomizer(this.alpha, sig)
      }
    } catch {
      /* keep the coordinator's result if local verify throws */
    }
    // Record this spend's signature under its on-chain index (dedup — the fixpoint may retry).
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
    if (req && this.d.mySeat() === 1 && this.sigs.length === total) {
      const resp = buildSignResponse(this.sigs)
      await this.d.rawSend(resp)
      this.d.onLog(`-> ${total} signature(s) handed to the helper`)
      this.helperReq = null
    }
    return true
  }
}
