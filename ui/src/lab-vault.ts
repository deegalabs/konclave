// The synthetic vault behind /lab/background-signer. Everything here lives in this page's memory
// and nowhere else: a 2-of-3 vault made by a real WASM DKG between three SIMULATED devices, each
// holding only its own share, talking over an in-memory bus instead of the relay. No IndexedDB, no
// browser storage, no session map, no coordinator, no relay - the lab never touches a vault a member
// owns.
//
// It used to. The page listed the device's real vaults, unlocked one (which registers its keys with
// the hosted coordinator), joined that vault's REAL signing room and could publish a test request
// into it, where the members' own signers received it. A lab is a demonstration of the engine, so
// it gets an engine of its own.
//
// What each device runs is the product's, and what it does not run is said here rather than implied:
//  - RUN: the product's `BackgroundSession` and signing machine (each device reads and checks the
//    request on its own: `readForSigning`, its own sighash, the header against this build's epoch
//    table, the fee); the money gate (`gateDecision`, against what the lab approved); and the
//    owner's side through the product's `OwnerSigning` (consent, claim, the "second transaction"
//    rule, the record written before a share leaves), over a record store held in memory.
//  - NOT RUN: anything that needs a coordinator or a relay. The approved lines are the vector's own
//    reading, made by the lab, not a proposal fetched from the coordinator; the vault's own receivers
//    are empty (the vector pays this vault no change); the request is plaintext on the bus (no
//    device-key sealing, #63); the seats and the tally are proven by the shares as in the product,
//    but no write key is registered anywhere (ADR-0011); and the record dies with the page.
//
// The screen is `BackgroundSignerLab.tsx`, and it is the only importer of this file
// (lab-isolation.test.ts). This file has no React, so a test drives it whole (`lab-vault.test.ts`),
// with the network and every storage taken away.

import { DkgSession, identifierBytes, ordinaryExpiry, pcztSighash, readPayment, upgradeHeight } from './wasm-pkg/konclave_wasm.js'
import { bytesToHex } from './bytes'
import { REQUEST_KIND } from './net-sign'
import { parseAlphas } from './signing'
import { dkgProvenPczt, vectorWithExpiry } from './demo-vector'
import { BackgroundSession } from './background-session'
import { gateDecision, type ApprovedLine, type PcztPayment } from './approved-payment'
import { makeSigningGate } from './signing-gate'
import { OwnerSigning } from './owner-signing'
import { readSigned, type RecordStore } from './signed-record'
import type { SignPreview } from './signing-machine'

/** One simulated device, as the screen shows it. */
export interface LabDevice {
  seat: number
  /** Whether this device's owner signed (approved) the lab payment. */
  approved: boolean
  seats: number
  phase: 'idle' | 'signing' | 'signed'
  what: SignPreview | null
  signature: { hex: string; ok: boolean } | null
  /** The refusal the device reported, as an i18n key (the machine's own wording). */
  error: string
}

export interface LabVaultOptions {
  /** Called after anything a device shows has changed. Not called while the vault is being built. */
  onChange: () => void
  /** What the lab approved. Defaults to what the test transaction pays; a test passes something
   *  else to see the comparison refuse. */
  approval?: ApprovedLine[]
}

interface Device extends LabDevice {
  tag: string
  session: BackgroundSession
  owner: OwnerSigning
  /** The owner's record store, kept here so a test can read what was recorded. */
  store: RecordStore
  delivered: Set<number>
}

/** The lab's only proposal id. Nothing outside this page ever sees it. */
const LAB_PROPOSAL = 'lab-payment'

/** A record store that lives in this page's memory: the product's store is the browser's storage. */
function memoryStore(): RecordStore {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) } }
}

/** The test transaction: the demo vector with its expiry moved to the one an honest builder would
 *  set now, by this device's clock, as the epoch table in WASM says (#638). */
function testTransaction(): Uint8Array {
  const expiry = ordinaryExpiry()
  if (expiry === 0) throw new Error("this device's clock is earlier than the network this app signs for")
  return vectorWithExpiry(dkgProvenPczt(), expiry)
}

/** The approval the lab gives: exactly what the transaction pays, read by the WASM, so a request
 *  that pays anything else is refused the way the product refuses it. */
function approvalOf(pczt: Uint8Array): ApprovedLine[] {
  const payment = JSON.parse(readPayment(pczt)) as PcztPayment
  return payment.outputs
    .filter((o) => (o.value ?? 0) > 0 && o.recipient !== null)
    .map((o) => ({ toReceiver: o.recipient!, amountZat: o.value!, memo: o.memo ?? '' }))
}

/** The sign-request the lab publishes on its own bus, in the shape the coordinator sends. */
function labRequest(pczt: Uint8Array): string {
  const spends = parseAlphas(pczt).map((s) => ({ index: s.index, alpha: bytesToHex(s.alpha) }))
  return JSON.stringify({ kind: REQUEST_KIND, sighash: bytesToHex(pcztSighash(pczt)), spends, pczt_hex: bytesToHex(pczt) })
}

/** A real DKG among `n` simulated devices, threshold `t`, run entirely in memory: every round-2
 *  package is handed to its recipient here, never sealed, sent or stored. */
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
    this.pczt = testTransaction()
    const approved = opts.approval ?? approvalOf(this.pczt)
    const { shares, groupVk, pubkeys } = dkg(this.threshold, this.total)
    const vault = bytesToHex(groupVk)
    this.groupKeyHex = vault
    this.onChange = opts.onChange
    // Silent until the vault exists: the sessions call back while they are being built, and a
    // caller's `onChange` that reads the vault would then reach a binding still being initialised
    // (the page did exactly that, and threw, the first time it ran in a browser).
    const changed = () => { if (this.built) this.onChange() }
    this.devices = shares.map((share, i) => {
      const seat = i + 1
      const store = memoryStore()
      const owner = new OwnerSigning(store)
      const dev = {
        seat, tag: `lab-device-${seat}`, approved: false, seats: 0, phase: 'idle', what: null, signature: null,
        error: '', owner, store, delivered: new Set<number>(),
      } as Omit<Device, 'session'> as Device
      dev.session = new BackgroundSession({
        myTag: dev.tag,
        mySeat: seat,
        signingMaterial: () => ({ keyPackage: share.keyPackage(), groupVk, pubkeys }),
        threshold: () => this.threshold,
        send: async (data) => { this.post(dev.tag, data); return true },
        // The vault's own receivers are empty: the vector pays this vault no change, so every
        // value-moving output must match an approved line.
        decideApproval: (outputs) => gateDecision({ approved, ourReceivers: [] }, outputs),
        // The product's gate and owner, as VaultSigner wires them: manual, and armed only by this
        // device's owner's own signature within its window.
        gate: makeSigningGate({ mode: () => 'manual', isApproved: () => true, isArmed: () => owner.allows(LAB_PROPOSAL) }),
        claim: async (sighashHex, expiry) => {
          const r = await owner.claim(vault, LAB_PROPOSAL, sighashHex, expiry)
          if (r === 'unreadable') throw new Error('[unreadable] this device could not read what it signed')
          return r === 'ok'
        },
        record: (sighashHex, expiry, branch) => owner.record(sighashHex, expiry, branch),
        onWithdrawn: () => { owner.withdraw(); dev.approved = false; changed() },
        onSeatCount: (n) => { dev.seats = n; changed() },
        onPhase: (p) => { dev.phase = p; changed() },
        onWhat: (w) => { dev.what = w; changed() },
        onSignature: (hex, ok) => { dev.signature = { hex, ok }; changed() },
        onError: (m) => { dev.error = m; changed() },
      })
      dev.session.setProposal(LAB_PROPOSAL)
      owner.open(LAB_PROPOSAL)
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

  /** What device `seat` recorded before its share left, as the product's record keeps it (hashed). */
  records(seat: number): readonly { h: string; e: number; b?: number }[] {
    const d = this.devices[seat - 1]
    return d ? readSigned(d.store, this.groupKeyHex, LAB_PROPOSAL) : []
  }

  /** Whether the network has moved past the upgrade the test transaction was built for, by this
   *  device's clock and the epoch table: then every device refuses it, correctly, and the page says
   *  the vector is too old rather than blaming the device's clock or version. */
  vectorPredatesUpgrade(): boolean {
    return ordinaryExpiry() > upgradeHeight()
  }

  /** Each device announces its seat. */
  seat(): Promise<void> {
    return this.serial(async () => {
      for (const d of this.devices) await d.session.start()
    })
  }

  /** The owners of `seats` sign the lab payment, one after the other, as members do: the consent
   *  first, then the signature into the room, from one clock read (VaultSigner's order). */
  approve(seats: number[]): Promise<void> {
    return this.serial(async () => {
      for (const s of seats) {
        const d = this.devices[s - 1]
        if (!d || d.approved) continue
        const now = Date.now()
        d.owner.give(LAB_PROPOSAL, now)
        d.approved = true
        d.error = ''
        await d.session.arm(LAB_PROPOSAL, now)
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
