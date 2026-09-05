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
import { signArmed } from './room-auth'
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

  it('BUG #356: a signature read back from the room still counts, or the quorum never closes', async () => {
    // Both members present, one has signed, and the other device joined afterwards. It learns that
    // signature only by reading the room back. #354 cut history off at the transport and starved
    // this: the panel sat at "1 of 2" with 2/2 present and nothing wrong on screen.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), open)
    const B = makeDev('b-tag', 2, bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), open)
    A.session.setProposal('p1')
    B.session.setProposal('p1')

    // B signed before A was listening. A reads it back from the room, marked historical.
    await B.session.arm('p1')
    const armed = bus.msgs[bus.msgs.length - 1]!
    await A.session.onMessage(armed.from, armed.data, true)
    expect(A.armedSeats).toEqual([2])

    // A signs too, and the quorum closes.
    await A.session.arm('p1')
    for (const m of bus.msgs) await A.session.onMessage(m.from, m.data, false)
    expect(A.armedSeats).toEqual([1, 2])
  })

  it('BUG #354: a ceremony message read back from the room is dropped, whatever else it carries', async () => {
    // The counterpart. The room is permanent, so a finished payment's request and commitments are
    // still in it. Replayed into a fresh ceremony they are what FROST rejects. A device that
    // reloaded mid-ceremony lost its nonces with the page anyway, so nothing is given up here.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), open)
    const B = makeDev('b-tag', 2, bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), open)
    await A.session.start()
    await B.session.start()
    await run([A, B], bus)

    const request = requestFor(dkgProvenPczt())
    // Delivered as history: the coordinator does not react at all, so no ceremony begins.
    const before = bus.msgs.length
    await A.session.onMessage('helper', request, true)
    await B.session.onMessage('helper', request, true)
    const isType = (d: string, t: string) => { try { return (JSON.parse(d) as { type?: string }).type === t } catch { return false } }
    expect(bus.msgs.slice(before).some((m) => isType(m.data, 'sreq'))).toBe(false)
    expect(bus.msgs.slice(before).some((m) => isType(m.data, 's1'))).toBe(false)
    expect(A.session.isDone()).toBe(false)
    expect(A.sig).toBeNull()
    expect(B.sig).toBeNull()

    // The same request delivered live does start one, and it completes.
    bus.post('helper', request)
    await run([A, B], bus)
    expect(A.errors).toEqual([])
    expect(A.sig?.ok).toBe(true)
    expect(A.sig?.hex).toBe(B.sig?.hex)
  })

  it('BUG #354: a second payment on the same session never started, because nothing rearmed the machine', async () => {
    // Production has ONE permanent signing room per vault and one long-lived session on it. After a
    // payment completed, the machine stayed `done` with the previous ceremony's message, nonces and
    // result, and `rearm()` was called from nowhere outside its own test. So the panel opened on the
    // next payment still showing the last one as sent, and the ceremony that should have started
    // never did: `onSreq` returns early while `started` is true.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), open)
    const B = makeDev('b-tag', 2, bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), open)
    A.session.setProposal('payment-1')
    B.session.setProposal('payment-1')
    await A.session.start()
    await B.session.start()
    await run([A, B], bus)

    bus.post('helper', requestFor(dkgProvenPczt()))
    await run([A, B], bus)
    expect(A.session.isDone()).toBe(true)
    const first = A.sig?.hex
    expect(first).toBeTruthy()

    // The panel now opens on a DIFFERENT payment. That alone must put the machine back to zero.
    A.session.setProposal('payment-2')
    B.session.setProposal('payment-2')
    expect(A.session.isDone()).toBe(false)
    expect(B.session.isDone()).toBe(false)

    // And the next ceremony actually runs, rather than being swallowed by a machine that thinks it
    // already finished.
    bus.post('helper', requestFor(dkgProvenPczt()))
    await run([A, B], bus)
    expect(A.errors).toEqual([])
    expect(B.errors).toEqual([])
    expect(A.session.isDone()).toBe(true)
    expect(A.sig?.ok).toBe(true)
    expect(A.sig?.hex).toBe(B.sig?.hex)
  })

  it('closing and reopening the SAME payment does not throw away the ceremony', async () => {
    // The counterpart to the rule above: the panel goes to null when it closes, and that must not
    // reset anything. Only moving to a different payment does.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const open: GovernanceGate = () => true
    const A = makeDev('a-tag', 1, bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }), open)
    const B = makeDev('b-tag', 2, bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), open)
    A.session.setProposal('payment-1')
    B.session.setProposal('payment-1')
    await A.session.start()
    await B.session.start()
    await run([A, B], bus)
    bus.post('helper', requestFor(dkgProvenPczt()))
    await run([A, B], bus)
    expect(A.session.isDone()).toBe(true)

    A.session.setProposal(null)      // panel closed
    A.session.setProposal('payment-1') // reopened on the same payment
    expect(A.session.isDone()).toBe(true) // still finished; the result is still the user's to read
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
    // `keys` is handed back so a test can craft a room message that is AUTHENTIC, not merely
    // well-shaped: since #425 the tally messages are verified, so an unsigned one proves nothing
    // about expiry - it is just rejected for the other reason.
    return Object.assign(
      [
        makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open),
        makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open),
      ] as const,
      { keys: { s0, s1, groupVk, pubkeys } },
    )
  }

  it('signatures expire on the wire, so a stale room cannot hold a payment hostage', async () => {
    // What shipped: an attempt failed, its two signatures stayed in the permanent room, and on
    // reload both devices rebuilt a full quorum from tags that no longer existed. The payment read
    // as signed by ghosts and sendable by nobody: no button, no sender, no way out.
    const bus = new Bus()
    const stale = NOW - ARM_TTL_MS - 1
    const p = pair(bus)
    const [A, B] = p
    // Genuine signatures from the seats that gave them - only the CLOCK is stale. Since #425 an
    // unsigned message is refused for being unproven, so leaving these unsigned would have made
    // this test pass without the expiry rule existing at all.
    const gvk = bytesToHex(p.keys.groupVk)
    bus.post('gone-a', JSON.stringify({
      type: 'armed', seat: 1, proposal: 'p1', at: stale,
      sig: signArmed(p.keys.s0.keyPackage(), 1, gvk, 'gone-a', stale, 'p1'),
    }))
    bus.post('gone-b', JSON.stringify({
      type: 'armed', seat: 2, proposal: 'p1', at: stale,
      sig: signArmed(p.keys.s1.keyPackage(), 2, gvk, 'gone-b', stale, 'p1'),
    }))

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

  it('a signature with no timestamp never counts', async () => {
    // Two rules refuse this now and it is worth being straight about which: no real device can
    // produce it any more (the timestamp is inside what `armed` signs), so since #425 it is
    // refused for being unproven, and the timestamp rule below it never runs. The test stays
    // because what must hold is that it NEVER counts - not which rule stops it.
    const bus = new Bus()
    bus.post('gone-a', JSON.stringify({ type: 'armed', seat: 1, proposal: 'p1' }))
    bus.post('gone-b', JSON.stringify({ type: 'armed', seat: 2, proposal: 'p1' }))
    const [A, B] = pair(bus)
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    expect(A.armedSeats).toEqual([])
  })

  it('a fresh signature still counts', async () => {
    // The companion to the two tests above: the expiry rule must not swallow a LIVE signature read
    // back from the room. Signed by seat 2's own share for the tag it is posted from, so what is
    // being tested is the timestamp and nothing else (#425 made an unsigned one fail for a
    // different reason entirely, which would have made this test lie about what it proves).
    const bus = new Bus()
    const p = pair(bus)
    const [A, B] = p
    const at = NOW - 1000
    const sig = signArmed(p.keys.s1.keyPackage(), 2, bytesToHex(p.keys.groupVk), 'someone', at, 'p1')
    bus.post('someone', JSON.stringify({ type: 'armed', seat: 2, proposal: 'p1', at, sig }))
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
    // `keys` is handed back so a test can craft a room message that is AUTHENTIC, not merely
    // well-shaped: since #425 the tally messages are verified, so an unsigned one proves nothing
    // about expiry - it is just rejected for the other reason.
    return Object.assign(
      [
        makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open),
        makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open),
      ] as const,
      { keys: { s0, s1, groupVk, pubkeys } },
    )
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

// #425: the two messages that carry the tally were left plain when `rejoin` was signed. Anyone who
// could write to the room could clear every device's count - repeatedly, so a payment never reached
// a quorum - or forge `armed` for absent seats until the panel named a sender that would never
// send. No money moves either way; this is denial of send. These drive the real attack over the
// same in-memory room the happy path uses.
describe('BackgroundSession - the tally cannot be moved by someone without a share (#425)', () => {
  const mat = (kp: Uint8Array, groupVk: Uint8Array, pubkeys: Uint8Array) => () => ({ keyPackage: kp, groupVk, pubkeys })
  const pair = (bus: Bus) => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const open: GovernanceGate = () => true
    return Object.assign(
      [
        makeDev('a-tag', 1, bus, mat(s0.keyPackage(), groupVk, pubkeys), open),
        makeDev('b-tag', 2, bus, mat(s1.keyPackage(), groupVk, pubkeys), open),
      ] as const,
      { keys: { s0, s1, groupVk, pubkeys } },
    )
  }

  /** Both devices sign `p1`, so the tally is full and a sender is named. */
  async function armedQuorum(bus: Bus, p: ReturnType<typeof pair>) {
    const [A, B] = p
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    await A.session.arm('p1'); await B.session.arm('p1'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1, 2])
    return [A, B] as const
  }

  it('an outsider cannot zero the tally with a forged unarmed', async () => {
    // The attack, exactly: post `unarmed` for the payment on screen and every device runs
    // `armed.clear()`. Repeatable, so the payment could never accumulate a quorum.
    const bus = new Bus()
    const p = pair(bus)
    const [A, B] = await armedQuorum(bus, p)

    bus.post('attacker', JSON.stringify({ type: 'unarmed', proposal: 'p1' }))
    bus.post('attacker', JSON.stringify({ type: 'unarmed', proposal: 'p1', seat: 1 }))
    bus.post('attacker', JSON.stringify({ type: 'unarmed', proposal: 'p1', seat: 1, sig: 'ff'.repeat(64) }))
    await run([A, B], bus)

    expect(A.armedSeats, 'the tally must survive an unsigned withdrawal').toEqual([1, 2])
    expect(B.armedSeats).toEqual([1, 2])
  })

  it('an outsider cannot replay a real unarmed from another tag', async () => {
    // Seat 1 legitimately withdraws once. The attacker captures that message and re-sends it under
    // their own tag to zero the tally again after the members have signed afresh.
    const bus = new Bus()
    const p = pair(bus)
    const [A, B] = await armedQuorum(bus, p)
    await A.session.unarm('p1'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([])
    const captured = bus.msgs.filter((m) => m.data.includes('"unarmed"')).at(-1)!.data

    // Both sign again, and the attacker replays what it captured.
    await A.session.arm('p1'); await B.session.arm('p1'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([1, 2])
    bus.post('attacker', captured)
    await run([A, B], bus)

    expect(A.armedSeats, 'a captured withdrawal must not work from another tag').toEqual([1, 2])
  })

  it('a real withdrawal by a seated member still works', async () => {
    // The other half: making it strict must not take away the ability to withdraw, which is the
    // whole point of `unarm` (an attempt failed, nothing moved, everyone decides again).
    const bus = new Bus()
    const p = pair(bus)
    const [A, B] = await armedQuorum(bus, p)
    await B.session.unarm('p1', 'ceremony'); await run([A, B], bus)
    expect(A.armedSeats).toEqual([])
    expect(B.armedSeats).toEqual([])
    expect(A.failure).toBe('ceremony') // and the reason still reaches everyone
  })

  it('an outsider cannot forge an arming for a seat it does not hold', async () => {
    // The other direction: park the payment by arming absent seats until the panel names a sender
    // that will never send, and it sits for the full arm TTL.
    const bus = new Bus()
    const p = pair(bus)
    const [A, B] = p
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)

    bus.post('attacker', JSON.stringify({ type: 'armed', seat: 2, proposal: 'p1', at: NOW }))
    bus.post('attacker', JSON.stringify({ type: 'armed', seat: 2, proposal: 'p1', at: NOW, sig: 'ab'.repeat(64) }))
    await run([A, B], bus)

    expect(A.armedSeats, 'no seat is armed by someone without its share').toEqual([])
    expect(A.namedSender).toBeNull()
  })

  it('a member cannot arm a DIFFERENT seat than its own', async () => {
    // Seat 1 is a real member with a real share. It still cannot sign seat 2's arming: the seat is
    // inside the signed message and verified against THAT seat's verifying share.
    const bus = new Bus()
    const p = pair(bus)
    const [A, B] = p
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)

    const at = NOW
    bus.post('a-tag', JSON.stringify({
      type: 'armed', seat: 2, proposal: 'p1', at,
      sig: signArmed(p.keys.s0.keyPackage(), 2, bytesToHex(p.keys.groupVk), 'a-tag', at, 'p1'),
    }))
    await run([A, B], bus)
    expect(A.armedSeats).toEqual([])
  })

  it('an arming cannot be moved to a DIFFERENT payment', async () => {
    // The proposal is inside the signed message, so a genuine arming for p1 cannot be re-posted as
    // an arming for p2 - which would otherwise let a captured message complete a quorum on a
    // payment its owner never looked at.
    const bus = new Bus()
    const p = pair(bus)
    const [A, B] = p
    A.session.setProposal('p1'); B.session.setProposal('p1')
    await A.session.start(); await B.session.start(); await run([A, B], bus)
    await B.session.arm('p1'); await run([A, B], bus)
    const real = JSON.parse(bus.msgs.filter((m) => m.data.includes('"armed"')).at(-1)!.data) as Record<string, unknown>

    A.session.setProposal('p2'); B.session.setProposal('p2')
    await run([A, B], bus)
    bus.post('b-tag', JSON.stringify({ ...real, proposal: 'p2' }))
    await run([A, B], bus)

    expect(A.armedSeats, 'an arming for another payment must not count here').toEqual([])
  })

  it('the withdrawal reason cannot be swapped in flight', async () => {
    // `code` is inside what `unarmed` signs, so the relay (or anyone in the room) cannot turn
    // "the ceremony failed" into "not enough funds" - each device writes its own sentence from it.
    const bus = new Bus()
    const p = pair(bus)
    const [A, B] = await armedQuorum(bus, p)
    await B.session.unarm('p1', 'ceremony')
    const real = JSON.parse(bus.msgs.filter((m) => m.data.includes('"unarmed"')).at(-1)!.data) as Record<string, unknown>
    bus.msgs.length = bus.msgs.length - 1 // drop the genuine one; deliver only the tampered copy
    bus.post('b-tag', JSON.stringify({ ...real, code: 'funds' }))
    await run([A, B], bus)

    expect(A.armedSeats, 'a tampered withdrawal changes nothing').toEqual([1, 2])
    expect(A.failure).toBeNull()
  })
})
