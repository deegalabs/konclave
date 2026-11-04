// The synthetic vault behind /lab/background-signer. Everything here lives in this page's memory
// and nowhere else: a 2-of-3 vault made by a real WASM DKG between three SIMULATED devices, each
// holding only its own share, talking over an in-memory bus instead of the relay. No IndexedDB, no
// session map, no coordinator, no relay - the lab never touches a vault a member owns.
//
// It used to. The page listed the device's real vaults, unlocked one (which registers its keys with
// the hosted coordinator), joined that vault's REAL signing room and could publish a test request
// into it, where the members' own signers received it. A lab is a demonstration of the engine, so
// it gets an engine of its own.
//
// The devices run the same `BackgroundSession` the product runs, with every gate the product has:
// the request is read and checked on each device, compared with what the lab approved, claimed,
// recorded, and only then signed. The lab's approval is the vector's own reading, made when the
// vault is created, so the comparison is a real one and not a constant `match`.
//
// What the screen renders is in `BackgroundSignerLab.tsx`; this file has no React, so a test drives
// it whole (`lab-vault.test.ts`), with the network and IndexedDB taken away.

import { DkgSession, identifierBytes, pcztSighash, readPayment } from './wasm-pkg/konclave_wasm.js'
import { bytesToHex } from './bytes'
import { parseAlphas } from './signing'
import { dkgProvenPczt, withExpiry } from './demo-vector'
import { BackgroundSession } from './background-session'
import { gateDecision, type ApprovedLine, type PcztPayment } from './approved-payment'
import type { GovernanceGate } from './background-signer'
import type { SignPreview } from './signing-machine'

/** One simulated device, as the screen shows it. */
export interface LabDevice {
  seat: number
  /** Whether this device's owner approved the lab payment. */
  approved: boolean
  seats: number
  phase: 'idle' | 'signing' | 'signed'
  what: SignPreview | null
  signature: { hex: string; ok: boolean } | null
  error: string
}

interface Device extends LabDevice {
  tag: string
  session: BackgroundSession
  delivered: Set<number>
  /** The one transaction this device's owner consented to (the product's rule: one per consent). */
  claimed: string | null
  /** What this device recorded before its share left, kept in memory only. */
  records: { sighash: string; expiry: number; branch: number }[]
}

/** The lab's only proposal id. Nothing outside this page ever sees it. */
export const LAB_PROPOSAL = 'lab-payment'

/** The approval the lab gives: exactly what the vector pays, read by the WASM, so a request that
 *  pays anything else is refused the way the product refuses it. */
function approvalOf(pczt: Uint8Array): ApprovedLine[] {
  const payment = JSON.parse(readPayment(pczt)) as PcztPayment
  return payment.outputs
    .filter((o) => (o.value ?? 0) > 0 && o.recipient !== null)
    .map((o) => ({ toReceiver: o.recipient!, amountZat: o.value!, memo: o.memo ?? '' }))
}

/** The test sign-request the lab publishes on its own bus, in the shape the coordinator sends. */
export function labRequest(pczt: Uint8Array): string {
  const spends = parseAlphas(pczt).map((s) => ({ index: s.index, alpha: bytesToHex(s.alpha) }))
  return JSON.stringify({ kind: 'net-sign-request', sighash: bytesToHex(pcztSighash(pczt)), spends, pczt_hex: bytesToHex(pczt) })
}

/** A real DKG among `n` simulated devices, threshold `t`, run entirely in memory. */
function dkg(t: number, n: number) {
  const ids = Array.from({ length: n }, (_, i) => identifierBytes(i + 1))
  const sessions = ids.map((id) => new DkgSession(id, n, t))
  const r1 = sessions.map((s) => s.round1Package())
  sessions.forEach((s, i) => r1.forEach((pkg, j) => { if (i !== j) s.addRound1(ids[j]!, pkg) }))
  sessions.forEach((s) => s.part2())
  sessions.forEach((s, i) => {
    for (let k = 0; k < s.round2Count(); k++) {
      const to = bytesToHex(s.round2Recipient(k))
      const j = ids.findIndex((id) => bytesToHex(id) === to)
      sessions[j]!.addRound2(ids[i]!, s.round2Package(k))
    }
  })
  sessions.forEach((s) => s.part3())
  return { shares: sessions, groupVk: sessions[0]!.groupVk(), pubkeys: sessions[0]!.pubkeys() }
}

export interface LabVaultOptions {
  /** The governance policy (auto / manual), read live on every request. */
  gate: GovernanceGate
  /** Called after anything a device shows has changed. */
  onChange: () => void
  /** The proven PCZT the lab signs. Defaults to the demo vector with an honest expiry for now. */
  pczt?: Uint8Array
  /** What the lab approved. Defaults to what `pczt` pays; a test passes something else to see the
   *  comparison refuse. */
  approval?: ApprovedLine[]
}

/** A 2-of-3 vault that exists only in this page. Wasm must be initialised first (`ensureWasm`). */
export class LabVault {
  readonly threshold = 2
  readonly total = 3
  /** The group verifying key, shown so two lab vaults can be told apart. */
  readonly groupKeyHex: string
  private readonly devices: Device[]
  private readonly msgs: { seq: number; from: string; data: string }[] = []
  private readonly pczt: Uint8Array
  private readonly onChange: () => void
  private queue: Promise<void> = Promise.resolve()
  private built = false

  constructor(opts: LabVaultOptions) {
    this.pczt = opts.pczt ?? withExpiry(dkgProvenPczt())
    const approved = opts.approval ?? approvalOf(this.pczt)
    const { shares, groupVk, pubkeys } = dkg(this.threshold, this.total)
    this.groupKeyHex = bytesToHex(groupVk)
    this.onChange = opts.onChange
    // Silent until the vault exists: the sessions call back while they are being built, and a
    // caller's `onChange` that reads the vault would then reach a binding still being initialised
    // (the page did exactly that, and threw, the first time it ran in a browser).
    const changed = () => { if (this.built) this.onChange() }
    this.devices = shares.map((share, i) => {
      const seat = i + 1
      const dev = {
        seat, tag: `lab-device-${seat}`, approved: false, seats: 0, phase: 'idle', what: null, signature: null,
        error: '', delivered: new Set<number>(), claimed: null, records: [],
      } as unknown as Device
      dev.session = new BackgroundSession({
        myTag: dev.tag,
        mySeat: seat,
        signingMaterial: () => ({ keyPackage: share.keyPackage(), groupVk, pubkeys }),
        threshold: () => this.threshold,
        send: async (data) => { this.post(dev.tag, data); return true },
        // The vault's own receivers are empty: the vector pays no change to this vault, so every
        // value-moving output must match an approved line.
        decideApproval: (outputs) => gateDecision({ approved, ourReceivers: [] }, outputs),
        claim: (sighash) => {
          if (dev.claimed === null) dev.claimed = sighash
          return dev.claimed === sighash
        },
        // One entry per transaction however often it is asked, as the product's store keeps it: the
        // machine records before EVERY share, and the vector has four spends.
        record: async (sighash, expiry, branch) => {
          if (!dev.records.some((r) => r.sighash === sighash)) dev.records.push({ sighash, expiry, branch })
        },
        // A device signs only for an owner who approved, as in the product, and then under the
        // page's policy (auto / manual).
        gate: (ctx) => dev.approved && opts.gate(ctx),
        onSeatCount: (n) => { dev.seats = n; changed() },
        onPhase: (p) => { dev.phase = p; changed() },
        onWhat: (w) => { dev.what = w; changed() },
        onSignature: (hex, ok) => { dev.signature = { hex, ok }; changed() },
        onError: (m) => { dev.error = m; changed() },
      })
      dev.session.setProposal(LAB_PROPOSAL)
      return dev
    })
    this.built = true
  }

  /** What each device shows, in seat order. */
  view(): LabDevice[] {
    return this.devices.map(({ seat, approved, seats, phase, what, signature, error }) => ({ seat, approved, seats, phase, what, signature, error }))
  }

  /** Every message the bus has carried, for a test to inspect. */
  wire(): readonly { from: string; data: string }[] {
    return this.msgs
  }

  /** What each device recorded before its share left. */
  records(seat: number): readonly { sighash: string; expiry: number; branch: number }[] {
    return this.devices[seat - 1]?.records ?? []
  }

  /** Each device announces its seat. */
  seat(): Promise<void> {
    return this.serial(async () => {
      for (const d of this.devices) await d.session.start()
    })
  }

  /** The owners of `seats` approve the lab payment, one after the other, as members do. */
  approve(seats: number[]): Promise<void> {
    return this.serial(async () => {
      for (const s of seats) {
        const d = this.devices[s - 1]
        if (!d || d.approved) continue
        d.approved = true
        await d.session.arm(LAB_PROPOSAL)
        await this.pump()
      }
    })
  }

  /** Publish the test request on the lab's bus, standing in for the coordinator. */
  request(): Promise<void> {
    return this.serial(async () => {
      for (const d of this.devices) d.error = ''
      this.post('lab-coordinator', labRequest(this.pczt))
    })
  }

  /** Re-drive the devices, after the policy changed (a manual payment was armed). */
  retry(): Promise<void> {
    return this.serial(async () => {
      for (const d of this.devices) await d.session.retry()
    })
  }

  private post(from: string, data: string): void {
    this.msgs.push({ seq: this.msgs.length, from, data })
  }

  /** Run `f`, then deliver until the bus is quiet. One at a time, so two clicks never interleave. */
  private serial(f: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      await f()
      await this.pump()
      this.onChange()
    })
    this.queue = next.catch(() => {})
    return next
  }

  /** Deliver every undelivered message to every device, in order, until nothing new is posted. */
  private async pump(): Promise<void> {
    let prev = -1
    for (let round = 0; this.msgs.length !== prev && round < 80; round++) {
      prev = this.msgs.length
      for (const d of this.devices) {
        for (const m of this.msgs) {
          if (d.delivered.has(m.seq)) continue
          d.delivered.add(m.seq)
          await d.session.onMessage(m.from, m.data)
        }
      }
    }
  }
}
