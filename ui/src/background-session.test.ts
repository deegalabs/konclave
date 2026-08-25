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
import { ARM_TTL_MS } from './signing-gate'
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

interface Dev { tag: string; session: BackgroundSession; delivered: Set<number>; sig: { hex: string; ok: boolean } | null; errors: string[]; seats: number; armedSeats: number[]; namedSender: string | null; failure: string | null }

let NOW = 1_700_000_000_000
function makeDev(tag: string, seat: number, bus: Bus, mat: () => { keyPackage: Uint8Array; groupVk: Uint8Array; pubkeys: Uint8Array }, gate: GovernanceGate): Dev {
  const dev: Dev = { tag, session: null as unknown as BackgroundSession, delivered: new Set(), sig: null, errors: [], seats: 0, armedSeats: [], namedSender: null, failure: null }
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
    now: () => NOW,
    onFailed: (c) => { dev.failure = c },
    onArmed: (seats, triggerTag) => {
      dev.armedSeats = seats
      if (triggerTag) dev.namedSender = triggerTag
    },
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

describe('BackgroundSession - everyone signs, the last one sends', () => {
  const mat = (kp: Uint8Array, groupVk: Uint8Array, pubkeys: Uint8Array) => () => ({ keyPackage: kp, groupVk, pubkeys })

  it('names exactly one sender - the device whose signature closed the quorum - and both agree', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open)
    const B = makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open)
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')

    await A.session.arm('p1')
    await run([A, B], bus)
    // One of two signed: nobody sends yet, on either device.
    expect(A.armedSeats).toEqual([1])
    expect(B.armedSeats).toEqual([1])
    expect(A.namedSender).toBeNull()
    expect(B.namedSender).toBeNull()

    await B.session.arm('p1')
    await run([A, B], bus)
    expect(A.armedSeats).toEqual([1, 2])
    expect(B.armedSeats).toEqual([1, 2])
    // The quorum closed on B's signature, so B sends - and A computes the same answer from the
    // same ordered log, so A does not also send.
    expect(A.namedSender).toBe('b-tag')
    expect(B.namedSender).toBe('b-tag')
  })

  it('a device re-announcing its own signature never re-fires the send', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open)
    const B = makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open)
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')

    await A.session.arm('p1'); await B.session.arm('p1'); await run([A, B], bus)
    expect(B.namedSender).toBe('b-tag')
    B.namedSender = null
    // B reloads and re-announces (same seat, and again after A repeats too): still no new sender.
    await B.session.arm('p1'); await A.session.arm('p1'); await run([A, B], bus)
    expect(B.namedSender).toBeNull()
    expect(A.armedSeats).toEqual([1, 2])
  })

  it('a signature announced for another payment never counts toward this one', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open)
    const B = makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open)
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    A.session.setProposal('p-old'); B.session.setProposal('p-old')

    await A.session.arm('p-old')
    await run([A, B], bus)
    expect(A.armedSeats).toEqual([1])

    // Both devices move to a different payment: the previous one's signatures do not carry over.
    A.session.setProposal('p-new'); B.session.setProposal('p-new')
    expect(A.armedSeats).toEqual([])
    await B.session.arm('p-new')
    await run([A, B], bus)
    expect(A.armedSeats).toEqual([2])
    expect(A.namedSender).toBeNull() // one of two on the new payment: nothing sends
  })

  it('replaying the room does not rebuild a quorum from a payment already sent', async () => {
    // The signing room is permanent, so its log still holds every earlier payment's signatures and
    // a device joining replays the whole thing. This is the bug that shipped: the previous
    // payment's two signatures counted as a full quorum for the payroll on screen, so the panel
    // announced "2 of 2 signed" for something nobody had signed - and never offered the button.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    // The room already carries a completed payment's signatures, from tags long gone.
    bus.post('p-old-a', JSON.stringify({ type: 'armed', seat: 1, proposal: 'p-sent' }))
    bus.post('p-old-b', JSON.stringify({ type: 'armed', seat: 2, proposal: 'p-sent' }))

    const A = makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open)
    const B = makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open)
    A.session.setProposal('p-new'); B.session.setProposal('p-new')
    await A.session.start(); await B.session.start(); await run([A, B], bus)

    expect(A.armedSeats).toEqual([]) // nobody has signed THIS payment
    expect(B.armedSeats).toEqual([])
    expect(A.namedSender).toBeNull() // and nothing was named to send it
    expect(B.namedSender).toBeNull()

    // Signing it now works normally, from zero.
    await A.session.arm('p-new'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1])
    await B.session.arm('p-new'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1, 2])
    expect(A.namedSender).toBe('b-tag')
    expect(B.namedSender).toBe('b-tag')
  })

  it('a device that did not sign contributes nothing: the quorum never closes', async () => {
    // The behavioural change: presence used to be enough (the gate said yes to anyone present).
    // Now an unsigned device stays out, so a payment nobody signed produces no signature at all.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const armed = new Set<string>()
    const gateFor = (tag: string): GovernanceGate => () => armed.has(tag)
    const A = makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), gateFor('a-tag'))
    const B = makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), gateFor('b-tag'))
    await A.session.start(); await B.session.start(); await run([A, B], bus)

    bus.post('helper', requestFor(dkgProvenPczt()))
    await run([A, B], bus)
    expect(A.sig).toBeNull()
    expect(B.sig).toBeNull()
    expect(A.session.isDone()).toBe(false)

    // Both owners sign: the same request now completes, with no new request from the helper.
    armed.add('a-tag'); armed.add('b-tag')
    await A.session.retry(); await B.session.retry()
    await run([A, B], bus)
    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true)
    expect(A.sig?.hex).toBe(B.sig?.hex)
  })
})

describe('BackgroundSession - a failed attempt must not freeze the payment', () => {
  const mat = (kp: Uint8Array, groupVk: Uint8Array, pubkeys: Uint8Array) => () => ({ keyPackage: kp, groupVk, pubkeys })
  const pair = (bus: Bus) => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const open: GovernanceGate = () => true
    return [
      makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open),
      makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open),
    ] as const
  }

  it('signatures expire on the wire, so a stale room cannot hold a payment hostage', async () => {
    // What shipped: an attempt failed, its two signatures stayed in the permanent room, and on
    // reload both devices rebuilt a full quorum from tags that no longer existed. The payment read
    // as signed by ghosts and sendable by nobody: no button, no sender, no way out.
    const bus = new Bus()
    const stale = NOW - ARM_TTL_MS - 1
    bus.post('gone-a', JSON.stringify({ type: 'armed', seat: 1, proposal: 'p1', at: stale }))
    bus.post('gone-b', JSON.stringify({ type: 'armed', seat: 2, proposal: 'p1', at: stale }))

    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)

    expect(A.armedSeats).toEqual([])
    expect(A.namedSender).toBeNull()

    // And it can be signed again, normally, from zero.
    await A.session.arm('p1'); await run([A, B], bus)
    await B.session.arm('p1'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1, 2])
    expect(A.namedSender).toBe('b-tag')
  })

  it('a signature with no timestamp is always stale: it can only be a leftover', async () => {
    const bus = new Bus()
    bus.post('gone-a', JSON.stringify({ type: 'armed', seat: 1, proposal: 'p1' }))
    bus.post('gone-b', JSON.stringify({ type: 'armed', seat: 2, proposal: 'p1' }))
    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    expect(A.armedSeats).toEqual([])
  })

  it('a fresh signature still counts', async () => {
    const bus = new Bus()
    bus.post('someone', JSON.stringify({ type: 'armed', seat: 2, proposal: 'p1', at: NOW - 1000 }))
    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    expect(A.armedSeats).toEqual([2])
  })

  it('withdrawing after a failure puts the payment back to unsigned everywhere', async () => {
    const bus = new Bus()
    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)

    await A.session.arm('p1'); await B.session.arm('p1'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1, 2])
    expect(B.namedSender).toBe('b-tag')

    // The send failed: nothing moved, so nobody is holding a signature any more.
    await B.session.unarm('p1'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([])
    expect(B.armedSeats).toEqual([])

    // ...and signing it again works, naming a sender again.
    A.namedSender = null; B.namedSender = null
    await A.session.arm('p1'); await B.session.arm('p1'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1, 2])
    expect(A.namedSender).toBe('b-tag')
  })

  it('a withdrawal for a different payment is ignored', async () => {
    const bus = new Bus()
    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    await A.session.arm('p1'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1])

    await B.session.unarm('p-other'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1]) // untouched
  })
})

describe('BackgroundSession - the whole vault learns a send failed, not only the sender', () => {
  const mat = (kp: Uint8Array, groupVk: Uint8Array, pubkeys: Uint8Array) => () => ({ keyPackage: kp, groupVk, pubkeys })
  const pair = (bus: Bus) => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const open: GovernanceGate = () => true
    return [
      makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open),
      makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open),
    ] as const
  }

  it('carries the reason to the devices that signed but did not send', async () => {
    // Only the sending device gets the reply. Without this the others sit on "sending" and never
    // learn the payment is not coming.
    const bus = new Bus()
    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    await A.session.arm('p1'); await B.session.arm('p1'); await run([A, B], bus)

    await B.session.unarm('p1', 'funds'); await run([A, B], bus)
    expect(A.failure).toBe('funds')
    expect(B.failure).toBe('funds')
    expect(A.armedSeats).toEqual([]) // and the payment is signable again
  })

  it('says nothing when there is no reason to give', async () => {
    const bus = new Bus()
    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    await A.session.arm('p1'); await run([A, B], bus)

    await B.session.unarm('p1'); await run([A, B], bus)
    expect(A.failure).toBeNull()
    expect(A.armedSeats).toEqual([])
  })

  it('ignores a failure announced for another payment', async () => {
    const bus = new Bus()
    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    await B.session.unarm('p-other', 'funds'); await run([A, B], bus)
    expect(A.failure).toBeNull()
  })
})
