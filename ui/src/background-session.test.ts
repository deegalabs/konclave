/// <reference types="node" />
// End-to-end test of the Stage-3 background session (#49): SigningSeats + BackgroundSigner composed
// over ONE in-memory relay room. Two devices, each with only its own share, ANNOUNCE their seats
// (rejoin) and then sign an (approved) payment entirely in the background - the full "send from the
// Dashboard" mechanism minus the React/RelaySession glue and the live broadcast.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { DkgSession, identifierBytes, pcztSighash } from './wasm-pkg/konclave_wasm.js'
import { bytesEqual } from './net'
import { dkgProvenPczt } from './demo-vector'
import { parseAlphas } from './signing'
import { bytesToHex } from './net-sign'
import { BackgroundSession } from './background-session'
import type { GovernanceGate } from './background-signer'

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
}

interface Dev { tag: string; session: BackgroundSession; delivered: Set<number>; sig: { hex: string; ok: boolean } | null; errors: string[]; seats: number }

function makeDev(tag: string, seat: number, bus: Bus, mat: () => { keyPackage: Uint8Array; groupVk: Uint8Array; pubkeys: Uint8Array }, gate: GovernanceGate): Dev {
  const dev: Dev = { tag, session: null as unknown as BackgroundSession, delivered: new Set(), sig: null, errors: [], seats: 0 }
  dev.session = new BackgroundSession({
    myTag: tag,
    mySeat: seat,
    signingMaterial: mat,
    threshold: () => 2,
    send: async (data) => { bus.post(tag, data); return true },
    gate,
    onError: (m) => dev.errors.push(m),
    onSignature: (hex, ok) => { dev.sig = { hex, ok } },
    onSeatCount: (n) => { dev.seats = n },
  })
  return dev
}

function requestFor(pczt: Uint8Array): string {
  const spends = parseAlphas(pczt).map((s) => ({ index: s.index, alpha: bytesToHex(s.alpha) }))
  return JSON.stringify({ kind: 'net-sign-request', sighash: bytesToHex(pcztSighash(pczt)), spends, pczt_hex: bytesToHex(pczt) })
}

async function run(devs: Dev[], bus: Bus) {
  let prev = -1
  for (let round = 0; bus.msgs.length !== prev && round < 80; round++) {
    prev = bus.msgs.length
    for (const d of devs) {
      for (const m of bus.msgs) {
        if (d.delivered.has(m.seq)) continue
        d.delivered.add(m.seq)
        await d.session.onMessage(m.from, m.data)
      }
    }
  }
}

describe('BackgroundSession - seated background signing (Stage 3 core, end to end)', () => {
  it('two devices announce seats, then sign an approved payment to a verifying signature', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), open)
    const B = makeDev('b-tag', 2, bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), open)

    // Each device announces its own seat on the signing room (the rejoin handshake).
    await A.session.start()
    await B.session.start()
    await run([A, B], bus)
    expect(A.session.seatCount()).toBe(2) // both seats present before any signing
    expect(B.session.seatCount()).toBe(2)

    // The helper publishes the sign-request into the same room; the devices sign in the background.
    bus.post('helper', requestFor(dkgProvenPczt()))
    await run([A, B], bus)

    expect(A.errors).toEqual([])
    expect(B.errors).toEqual([])
    expect(A.session.isDone()).toBe(true)
    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true)
    expect(A.sig?.hex).toBe(B.sig?.hex) // the two devices agree on the aggregate signature
  })

  it('a signing message that arrives before its sender is seated still completes (rejoin re-drives)', async () => {
    // Deliver the helper request BEFORE B has announced its seat, to exercise the fixpoint: the
    // coordinator's early messages referencing B wait until B's rejoin lands, then complete.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), open)
    const B = makeDev('b-tag', 2, bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), open)

    await A.session.start()
    bus.post('helper', requestFor(dkgProvenPczt())) // request arrives before B joins
    await run([A, B], bus)
    await B.session.start() // B finally announces its seat
    await run([A, B], bus)

    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true)
  })
})
