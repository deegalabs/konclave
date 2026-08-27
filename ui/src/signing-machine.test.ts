/// <reference types="node" />
// Orchestration test for the SigningMachine (issue #50) - the guard the /net ceremony never had.
// net-flow.test drives the WASM crypto directly; here we drive the RELAY STATE MACHINE: two
// SigningMachines, each with only its own share, exchange sreq|s1|sp|s2|signed over an in-memory
// bus (with the SAME fixpoint NetVault runs: a handler returning `false` is re-applied later), and
// must reach a verifying aggregate signature. A single-note self-contained ceremony, seeded by a
// helper sign-request, exactly as Architecture B drives it - proving the extracted machine keeps
// the proven money path's behavior, off the browser.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, {
  DkgSession,
  identifierBytes,
  pcztSighash,
} from './wasm-pkg/konclave_wasm.js'
import { bytesEqual, b64 } from './net'
import { dkgProvenPczt } from './demo-vector'
import { parseAlphas } from './signing'
import { bytesToHex, RESPONSE_KIND } from './net-sign'
import { SigningMachine, type SigningDeps } from './signing-machine'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

// A real 2-of-3 DKG in one process (same as net-flow), returning the two quorum sessions.
function dkg2of3() {
  const N = 3
  const T = 2
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

// An in-memory relay room: opaque messages, each tagged with its sender. A device receives EVERY
// message (its own included) exactly as the mailbox echoes to the poller - the coordinator needs
// its own commitment back, so this is load-bearing, not a shortcut.
interface Wire { seq: number; from: string; data: string }
class Bus {
  readonly msgs: Wire[] = []
  private seq = 0
  post(from: string, data: string) { this.msgs.push({ seq: this.seq++, from, data }) }
}

interface Device {
  tag: string
  machine: SigningMachine
  consumed: Set<number>
  sig: { hex: string; ok: boolean } | null
  errors: string[]
  bus: Bus // the CURRENT signing room (a re-armed device moves to a fresh one per payment)
}

const SEATS: Record<string, number> = { A: 1, B: 2 }

function makeDevice(tag: string, bus: Bus, mat: () => { keyPackage: Uint8Array; groupVk: Uint8Array; pubkeys: Uint8Array }): Device {
  const dev: Device = { tag, machine: null as unknown as SigningMachine, consumed: new Set(), sig: null, errors: [], bus }
  const deps: SigningDeps = {
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
  }
  dev.machine = new SigningMachine(deps)
  return dev
}

// A helper's Architecture-B sign-request over the vault's proven PCZT (sighash = the PCZT's real
// sighash, so each device's on-device H1 check passes by construction).
function signRequestFor(pczt: Uint8Array): { json: string; spendCount: number } {
  const spends = parseAlphas(pczt).map((s) => ({ index: s.index, alpha: bytesToHex(s.alpha) }))
  return {
    json: JSON.stringify({ kind: 'net-sign-request', sighash: bytesToHex(pcztSighash(pczt)), spends, pczt_hex: bytesToHex(pczt) }),
    spendCount: spends.length,
  }
}

// One device drains the bus to a fixpoint: apply every not-yet-consumed message; a `false` return
// leaves it unconsumed to be retried on the next sweep (exactly NetVault's advance()).
async function pump(dev: Device, bus: Bus) {
  let progressed = true
  while (progressed) {
    progressed = false
    for (const m of bus.msgs) {
      if (dev.consumed.has(m.seq)) continue
      if (await dev.machine.tryHelperRequest(m.data)) { dev.consumed.add(m.seq); progressed = true; continue }
      let parsed: { type?: string }
      try { parsed = JSON.parse(m.data) as { type?: string } } catch { dev.consumed.add(m.seq); continue }
      if (parsed.type && ['sreq', 's1', 'sp', 's2', 'signed'].includes(parsed.type)) {
        const ok = await dev.machine.handle(parsed as never, m.from)
        if (ok) { dev.consumed.add(m.seq); progressed = true }
      } else {
        dev.consumed.add(m.seq)
      }
    }
  }
}

// Drive both devices until the bus stops growing (the ceremony quiesces).
async function runCeremony(a: Device, b: Device, bus: Bus) {
  let prev = -1
  for (let round = 0; bus.msgs.length !== prev && round < 60; round++) {
    prev = bus.msgs.length
    await pump(a, bus)
    await pump(b, bus)
  }
}

describe('SigningMachine - relay orchestration (the /net ceremony state machine)', () => {
  it('two devices, each with only its own share, reach a verifying aggregate signature', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const A = makeDevice('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys })) // seat 1 = coordinator
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys })) // seat 2

    // A helper (Architecture B) publishes a sign-request over the vault's own proven PCZT. Its
    // sighash is the PCZT's real sighash, so each device's on-device H1 check passes by construction.
    const pczt = dkgProvenPczt()
    const spends = parseAlphas(pczt).map((s) => ({ index: s.index, alpha: bytesToHex(s.alpha) }))
    const requestJson = JSON.stringify({
      kind: 'net-sign-request',
      sighash: bytesToHex(pcztSighash(pczt)),
      spends,
      pczt_hex: bytesToHex(pczt),
    })
    bus.post('helper', requestJson)

    await runCeremony(A, B, bus)

    // Both devices independently reached a VERIFYING signature (each checks under ak+alpha itself).
    expect(A.errors).toEqual([])
    expect(B.errors).toEqual([])
    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true)
    // The two devices agree on the same aggregate signature.
    expect(A.sig?.hex).toBe(B.sig?.hex)
    expect(A.sig!.hex).toHaveLength(128) // 64-byte RedPallas signature

    // The coordinator handed the aggregate back to the helper RAW (the Architecture-B response).
    const response = bus.msgs.find((m) => {
      try { return (JSON.parse(m.data) as { kind?: string }).kind === RESPONSE_KIND } catch { return false }
    })
    expect(response).toBeDefined()
    const resp = JSON.parse(response!.data) as { sigs: { index: number; sig: string }[] }
    expect(resp.sigs).toHaveLength(spends.length)
  })

  it('the H1 sighash-binding refusal fires when the wire sighash does not match the PCZT', async () => {
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const A = makeDevice('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }))
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }))

    const pczt = dkgProvenPczt()
    // A hostile coordinator forwards an sreq whose `msg` is NOT this PCZT's sighash.
    const wrongSighash = new Uint8Array(32).fill(7)
    bus.post('A', JSON.stringify({ type: 'sreq', msg: b64(wrongSighash), pczt: b64(pczt) }))

    await runCeremony(A, B, bus)

    // Every device refuses (no signature produced); the machine surfaced the mismatch error.
    expect(A.sig).toBeNull()
    expect(B.sig).toBeNull()
    expect(B.errors.length).toBeGreaterThan(0)
  })

  it('H1 round 2: a coordinator cannot swap the message in the SigningPackage (#354)', async () => {
    // The `sreq` check binds round 1 to the sighash this device computed from its OWN PCZT. Round 2
    // used to hand that back: `onSp` overwrote the local sighash with the coordinator's wire value,
    // unchecked, and the share is computed over the coordinator's SigningPackage. So an honest
    // device displayed the transaction it had verified and signed the one it was handed.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const A = makeDevice('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }))
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }))

    const pczt = dkgProvenPczt()
    bus.post('helper', signRequestFor(pczt).json)
    // Let round 1 happen, then intercept: replace the coordinator's `sp` with one claiming a
    // DIFFERENT message. The SigningPackage bytes are left alone, so only the claim changes - which
    // is exactly the part the device used to trust.
    await pump(A, bus)  // A binds to the request and posts its round-1 commitment
    await pump(B, bus)  // B does the same
    await pump(A, bus)  // A now has both commitments and posts the SigningPackage
    const sp = bus.msgs.find((m) => { try { return (JSON.parse(m.data) as { type?: string }).type === 'sp' } catch { return false } })
    expect(sp).toBeDefined()
    const body = JSON.parse(sp!.data) as { msg: string }
    body.msg = b64(new Uint8Array(32).fill(9))
    sp!.data = JSON.stringify(body)

    await runCeremony(A, B, bus)

    // B refuses rather than signing a message its own PCZT does not commit to.
    expect(B.errors.length).toBeGreaterThan(0)
    expect(bus.msgs.some((m) => { try { return (JSON.parse(m.data) as { type?: string }).type === 's2' && m.from === 'B' } catch { return false } })).toBe(false)
  })

  it('a message tagged for a DIFFERENT transaction is dropped, an untagged one is not (#354)', async () => {
    // The signing room is permanent per vault, so two payments signed around the same time share one
    // stream. `k` scopes a message to a spend within a transaction; `h` scopes it to the transaction.
    // An absent tag is from an older build and must still be accepted, or a rollout cuts devices off.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const A = makeDevice('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }))
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }))

    const pczt = dkgProvenPczt()
    bus.post('helper', signRequestFor(pczt).json)
    await runCeremony(A, B, bus)
    expect(A.sig?.ok).toBe(true)

    // Every message this ceremony put on the wire carries the same tag, and it is the sighash prefix
    // both devices derived independently.
    const tagged = bus.msgs
      .map((m) => { try { return JSON.parse(m.data) as { type?: string; h?: string } } catch { return null } })
      .filter((o): o is { type: string; h: string } => !!o?.h)
    expect(tagged.length).toBeGreaterThan(0)
    const expected = bytesToHex(pcztSighash(pczt)).slice(0, 16)
    for (const o of tagged) expect(o.h).toBe(expected)
  })

  it('re-arm: the SAME machines sign a SECOND payment (fresh room) to a new verifying signature', async () => {
    // The background signer (Stage 3) reuses one machine across payments. Prove a machine signs
    // payment 1, `rearm()`s, and signs payment 2 in its OWN fresh room to another verifying sig,
    // with fresh nonces (so even the same tx yields a different, valid signature). /net never calls
    // rearm(), so its once-per-session behavior is unchanged.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus1 = new Bus()
    const A = makeDevice('A', bus1, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }))
    const B = makeDevice('B', bus1, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }))

    // Payment 1.
    const pczt = dkgProvenPczt()
    bus1.post('helper', signRequestFor(pczt).json)
    await runCeremony(A, B, bus1)
    expect(A.machine.isDone()).toBe(true)
    expect(B.machine.isDone()).toBe(true)
    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true)
    const sig1 = A.sig!.hex

    // Re-arm both devices into a NEW room (the provider's contract: never re-arm inside a used room).
    const bus2 = new Bus()
    for (const dev of [A, B]) {
      dev.machine.rearm()
      dev.bus = bus2
      dev.consumed = new Set()
      dev.sig = null
      dev.errors = []
      expect(dev.machine.isDone()).toBe(false) // rearm cleared the finished flag
    }

    // Payment 2 (same tx here; fresh nonces make the signature different but still valid).
    bus2.post('helper', signRequestFor(pczt).json)
    await runCeremony(A, B, bus2)
    expect(A.errors).toEqual([])
    expect(B.errors).toEqual([])
    expect(A.machine.isDone()).toBe(true)
    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true)
    expect(A.sig?.hex).toBe(B.sig?.hex) // the two devices agree on payment 2's signature
    expect(A.sig!.hex).not.toBe(sig1) // fresh nonces -> a genuinely new ceremony, not a replay
  })
})
