/// <reference types="node" />
// Tests for the app-level BackgroundSigner (issue #49, Stage 3): the per-vault signing room, the
// singleton guard, and - the point of Stage 3 - that a device signs FROM THE BACKGROUND only when
// the injected governance gate approves. Two signers exchange messages over an in-memory relay with
// the same fixpoint the live signer uses.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { DkgSession, identifierBytes } from './wasm-pkg/konclave_wasm.js'
import { bytesEqual } from './net'
import { dkgProvenPczt } from './demo-vector'
import { parseAlphas } from './signing'
import { bytesToHex } from './net-sign'
import { pcztSighash } from './wasm-pkg/konclave_wasm.js'
import {
  BackgroundSigner,
  signingRoom,
  acquireSigner,
  releaseSigner,
  isSignerActive,
  type GovernanceGate,
} from './background-signer'

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

function makeDev(tag: string, bus: Bus, mat: () => { keyPackage: Uint8Array; groupVk: Uint8Array; pubkeys: Uint8Array }, gate: GovernanceGate): Dev {
  const dev: Dev = { tag, signer: null as unknown as BackgroundSigner, delivered: new Set(), sig: null, errors: [], bus }
  dev.signer = new BackgroundSigner({
    signingMaterial: mat,
    seatOf: (t) => SEATS[t],
    mySeat: () => SEATS[tag]!,
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

    bus.post('helper', requestFor(dkgProvenPczt()))
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

    bus.post('helper', requestFor(dkgProvenPczt()))
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

    bus.post('helper', requestFor(dkgProvenPczt()))
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
