/// <reference types="node" />
// Tests for the app-level BackgroundSigner (issue #49, Stage 3): the per-vault signing room, the
// singleton guard, and - the point of Stage 3 - that a device signs FROM THE BACKGROUND only when
// the injected governance gate approves. Two signers exchange messages over an in-memory relay with
// the same fixpoint the live signer uses.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, afterAll } from 'vitest'
import init, { DkgSession, identifierBytes } from './wasm-pkg/konclave_wasm.js'
import { bytesEqual } from './net'
import { dkgProvenPczt } from './demo-vector'
import { honestExpiry, withExpiry, pinClock, unpinClock } from './test-vectors'
import { parseAlphas } from './signing'
import { bytesToHex } from './net-sign'
import { pcztSighash } from './wasm-pkg/konclave_wasm.js'
import { claimConsent, consentAllows, giveConsent, newConsent, type OwnerConsent } from './signing-gate'
import {
  BackgroundSigner,
  signingRoom,
  signingRoomFromSecret,
  acquireSigner,
  releaseSigner,
  isSignerActive,
  type GovernanceGate,
} from './background-signer'

beforeAll(pinClock)
afterAll(unpinClock)

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

function dkg2of3() {
  const N = 3, T = 2
  const ids = [1, 2, 3].map((i) => identifierBytes(i))
  const sessions = ids.map((id) => new DkgSession(id, N, T))
  const r1 = sessions.map((s) => s.round1Package())
  sessions.forEach((s, i) => r1.forEach((pkg, j) => { if (i !== j) s.addRound1(ids[j]!, pkg) }))
  sessions.forEach((s) => s.part2())
  sessions.forEach((s, i) => {
    for (let k = 0; k < s.round2Count(); k++) {
      const j = ids.findIndex((id) => bytesEqual(id, s.round2Recipient(k)))
      sessions[j]!.addRound2(ids[i]!, s.round2Package(k))
    }
  })
  sessions.forEach((s) => s.part3())
  const [s0, s1] = sessions as [DkgSession, DkgSession, DkgSession]
  return { s0, s1, groupVk: s0.groupVk(), pubkeys: s0.pubkeys() }
}

interface Wire { seq: number; from: string; data: string }
class Bus {
  readonly msgs: Wire[] = []
  private seq = 0
  post(from: string, data: string) { this.msgs.push({ seq: this.seq++, from, data }) }
  has(type: string) {
    return this.msgs.some((m) => { try { return (JSON.parse(m.data) as { type?: string }).type === type } catch { return false } })
  }
}

const SEATS: Record<string, number> = { A: 1, B: 2 }

interface Dev { tag: string; signer: BackgroundSigner; delivered: Set<number>; sig: { hex: string; ok: boolean } | null; errors: string[]; bus: Bus }

function makeDev(tag: string, bus: Bus, mat: () => { keyPackage: Uint8Array; groupVk: Uint8Array; pubkeys: Uint8Array }, gate: GovernanceGate, claim: (h: string) => boolean = () => true, record: (h: string, e: number) => Promise<void> = async () => {}): Dev {
  const dev: Dev = { tag, signer: null as unknown as BackgroundSigner, delivered: new Set(), sig: null, errors: [], bus }
  dev.signer = new BackgroundSigner({
    signingMaterial: mat,
    // #281 is asserted in signing-machine.test.ts, where the ceremony's own refusal lives. This
    // file exercises the GOVERNANCE gate (approve/arm), so the money gate is permissive here.
    decideApproval: () => 'match',
    claim,
    record,
    seatOf: (t) => SEATS[t],
    seatIsProven: () => true, // #399 is exercised in signing-machine.test.ts; all seats real here

    mySeat: () => SEATS[tag]!,
    myTag: () => tag,
    // This file exercises the governance gate with no signing tally; the room is taken to have named
    // A. Who the room names is tested in background-session.test.ts (SIGNER-SEAT1).
    coordinatorTag: () => 'A',
    threshold: () => 2,
    hasVault: () => true,
    send: async (m) => { dev.bus.post(tag, JSON.stringify(m)) },
    rawSend: async (data) => { dev.bus.post(tag, data); return true },
    onLog: () => {},
    onError: (msg) => dev.errors.push(msg),
    onPhase: () => {},
    onWhat: () => {},
    onSignature: (hex, ok) => { dev.sig = { hex, ok } },
    tt: (k) => k,
    gate,
  })
  return dev
}

function requestFor(pczt: Uint8Array): string {
  const spends = parseAlphas(pczt).map((s) => ({ index: s.index, alpha: bytesToHex(s.alpha) }))
  return JSON.stringify({ kind: 'net-sign-request', sighash: bytesToHex(pcztSighash(pczt)), spends, pczt_hex: bytesToHex(pczt) })
}

// Deliver every bus message to every device's feed() (own included - the mailbox echoes) until the
// bus stops growing (the ceremony quiesces).
async function run(devs: Dev[], bus: Bus) {
  let prev = -1
  for (let round = 0; bus.msgs.length !== prev && round < 80; round++) {
    prev = bus.msgs.length
    for (const d of devs) {
      for (const m of bus.msgs) {
        if (d.delivered.has(m.seq)) continue
        d.delivered.add(m.seq)
        await d.signer.feed(m.from, m.data)
      }
    }
  }
}

describe('signingRoom (per-vault, domain-separated)', () => {
  it('is a deterministic 128-bit hex id, key-sensitive', async () => {
    const gk = 'a25c53f7bf9a6f68b8b105503b23e6e22dd4033b00f5f9e6bb35b4bcd709a73a'
    const r = await signingRoom(gk)
    expect(r).toMatch(/^[0-9a-f]{32}$/)
    expect(await signingRoom(gk.toUpperCase())).toBe(r) // case-normalized -> every device agrees
    expect(await signingRoom('6b207009592233c7ab835765f35093ed357380589a4380a4d0cfd3c9d0c00c0b')).not.toBe(r)
  })
})

describe('signingRoomFromSecret (#388: signing room from S, not the public id)', () => {
  it('is a deterministic 128-bit hex id, secret-sensitive, and never the group-key room', async () => {
    const S = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1))
    const r = await signingRoomFromSecret(S)
    expect(r).toMatch(/^[0-9a-f]{32}$/)
    expect(await signingRoomFromSecret(S)).toBe(r) // deterministic -> every member agrees on the room
    const other = new Uint8Array(32).fill(9)
    expect(await signingRoomFromSecret(other)).not.toBe(r) // different S -> different room
    // Domain-separated from the group-key room: an id-only outsider cannot land on it even if the
    // S bytes happened to equal a group key (different prefix), and a migrated vault never collides
    // with its own legacy room.
    const sHex = Array.from(S, (x) => x.toString(16).padStart(2, '0')).join('')
    expect(await signingRoom(sHex)).not.toBe(r)
  })
})

describe('acquireSigner (singleton guard: one signer per vault per device)', () => {
  it('grants once, refuses a second, frees on release', () => {
    const v = 'vault-xyz'
    expect(acquireSigner(v)).toBe(true)
    expect(isSignerActive(v)).toBe(true)
    expect(acquireSigner(v)).toBe(false) // a second tab/instance is refused
    releaseSigner(v)
    expect(isSignerActive(v)).toBe(false)
    expect(acquireSigner(v)).toBe(true)
    releaseSigner(v)
  })
})

describe('BackgroundSigner (Dashboard-driven signing, governance-gated)', () => {
  it('with the gate OPEN, two devices sign a payment from the background to a verifying signature', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), open)
    const B = makeDev('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), open)

    bus.post('helper', requestFor(withExpiry(dkgProvenPczt())))
    await run([A, B], bus)

    expect(A.errors).toEqual([])
    expect(A.signer.isDone()).toBe(true)
    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true)
    expect(A.sig?.hex).toBe(B.sig?.hex)
  })

  it('with the gate CLOSED, the device does not participate (no sreq, no signature)', async () => {
    const { s0, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const closed: GovernanceGate = () => false // e.g. the owner has not approved this proposal
    const A = makeDev('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), closed)

    bus.post('helper', requestFor(withExpiry(dkgProvenPczt())))
    await run([A], bus)

    expect(bus.has('sreq')).toBe(false) // the coordinator never kicked off - a gate is not a signature
    expect(A.signer.isDone()).toBe(false)
    expect(A.sig).toBeNull()
  })

  it('a request pending on the gate proceeds after approval + retry (the manual-approval path)', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    let approved = false
    const gate: GovernanceGate = () => approved // flips when the owner approves
    const A = makeDev('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), gate)
    const B = makeDev('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), gate)

    bus.post('helper', requestFor(withExpiry(dkgProvenPczt())))
    await run([A, B], bus)
    expect(bus.has('sreq')).toBe(false) // still pending - nobody approved yet

    approved = true
    await A.signer.retry()
    await B.signer.retry()
    await run([A, B], bus) // now it flows to completion
    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true)
  })
})

// One signature from the owner covers one transaction, and the cover outlives the signing session:
// closing and reopening the panel starts a new session (a new machine), while the consent lives in
// the provider. Real machines, real WASM, two different real PCZTs for the same payment.
describe('the owner\'s consent across a new signing session', () => {
  // Another transaction for the same payment: the same vector with another expiry inside the window.
  const twoSpend = () => withExpiry(dkgProvenPczt(), honestExpiry() + 1)
  const consentGate = (c: OwnerConsent): GovernanceGate => () => consentAllows(c, 'p1', Date.now())
  const consentClaim = (c: OwnerConsent) => (h: string) => claimConsent(c, 'p1', Date.now(), h)

  it('a second transaction under the same signature gets no share, and a new signature covers it', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const ma = () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys })
    const mb = () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys })
    const ca = newConsent(), cb = newConsent()
    giveConsent(ca, 'p1', Date.now()); giveConsent(cb, 'p1', Date.now())

    // The first transaction: signed.
    const bus1 = new Bus()
    const A1 = makeDev('A', bus1, ma, consentGate(ca), consentClaim(ca))
    const B1 = makeDev('B', bus1, mb, consentGate(cb), consentClaim(cb))
    bus1.post('helper', requestFor(withExpiry(dkgProvenPczt())))
    await run([A1, B1], bus1)
    expect(A1.sig?.ok).toBe(true)

    // The panel closes and opens again: new sessions, the same consent. Another transaction for the
    // same payment gets nothing, and the refusal is the consent's.
    const bus2 = new Bus()
    const A2 = makeDev('A', bus2, ma, consentGate(ca), consentClaim(ca))
    const B2 = makeDev('B', bus2, mb, consentGate(cb), consentClaim(cb))
    bus2.post('helper', requestFor(twoSpend()))
    await run([A2, B2], bus2)
    expect(A2.sig).toBeNull()
    expect(bus2.msgs.some((m) => m.from === 'A' && m.data.includes('"s1"'))).toBe(false)
    expect(A2.errors).toContain('net.err.signedAnother')
    expect(ca.spent).toBe(true)

    // A new, deliberate signature covers the new transaction.
    giveConsent(ca, 'p1', Date.now()); giveConsent(cb, 'p1', Date.now())
    const bus3 = new Bus()
    const A3 = makeDev('A', bus3, ma, consentGate(ca), consentClaim(ca))
    const B3 = makeDev('B', bus3, mb, consentGate(cb), consentClaim(cb))
    bus3.post('helper', requestFor(twoSpend()))
    await run([A3, B3], bus3)
    expect(A3.errors).toEqual([])
    expect(A3.sig?.ok).toBe(true)
  })
})
