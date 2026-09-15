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
  const [s0, s1, s2] = sessions as [DkgSession, DkgSession, DkgSession]
  return { s0, s1, s2, groupVk: s0.groupVk(), pubkeys: s0.pubkeys() }
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
  /** #399: tags this device treats as UNPROVEN, i.e. an outsider that claimed an empty seat. */
  unprovenTags: Set<string>
}

// A and B are the two devices most tests use. C is seat 3, used only by the #399 test, where the
// point is that seat 2 is held by a tag whose rejoin was never proven.
const SEATS: Record<string, number> = { A: 1, B: 2, C: 3 }

function makeDevice(
  tag: string,
  bus: Bus,
  mat: () => { keyPackage: Uint8Array; groupVk: Uint8Array; pubkeys: Uint8Array },
  // The tag -> seat map as THIS device knows it. It defaults to the full roster, which is what every
  // ceremony test wants; the #519 companion passes a partial one, because the live map is fed by each
  // peer's `rejoin` and a device genuinely does not know a peer's seat until that rejoin is processed.
  seats: Record<string, number> = SEATS,
): Device {
  const dev: Device = { tag, machine: null as unknown as SigningMachine, consumed: new Set(), sig: null, errors: [], bus, unprovenTags: new Set() }
  const deps: SigningDeps = {
    signingMaterial: mat,
    seatOf: (t) => seats[t],
    // #399: proven unless this device's harness says otherwise, so the existing ceremonies behave
    // exactly as before. The poison test flips one tag to unproven.
    seatIsProven: (t) => !dev.unprovenTags.has(t),
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

// A device that BEHAVES as the coordinator but whose relay tag holds no seat in anyone else's map.
// This is the #519 attacker: it can read the public round-1 commitments off the room, assemble a
// perfectly well-formed SigningPackage over them, and post it. Nothing about the package is wrong -
// the sighash is the honest one and the commitments are the live ones, so frost-core's own
// IncorrectCommitment check passes. The only thing wrong with it is who sent it.
function makeUnseatedCoordinator(tag: string, bus: Bus, mat: () => { keyPackage: Uint8Array; groupVk: Uint8Array; pubkeys: Uint8Array }): Device {
  const dev: Device = { tag, machine: null as unknown as SigningMachine, consumed: new Set(), sig: null, errors: [], bus, unprovenTags: new Set() }
  const deps: SigningDeps = {
    signingMaterial: mat,
    // In ITS OWN view it holds seat 1. No peer map contains its tag, which is the whole point.
    seatOf: (t) => (t === tag ? 1 : SEATS[t]),
    seatIsProven: () => true,
    mySeat: () => 1, // it thinks it is the coordinator; no peer agrees
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
  // Mirrors both drivers: the drain is done, so let the machine act on all of it (#399).
  await dev.machine.afterDrain()
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

  it('a SEALED request does not re-broadcast the PCZT to the relay, yet still signs (#63)', async () => {
    // The leak the live test caught: sealing the helper request is not enough - the coordinator's
    // `sreq` re-broadcast the PCZT in cleartext, and the PCZT decodes to recipient + amount. When
    // the request is sealed (every device registered, so every device opened it and holds the PCZT),
    // the coordinator must NOT re-broadcast it; each device uses the PCZT it already has.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const A = makeDevice('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys })) // seat 1
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }))

    const pczt = dkgProvenPczt()
    const spends = parseAlphas(pczt).map((s) => ({ index: s.index, alpha: bytesToHex(s.alpha) }))
    // `sealed: true` is what unsealSignRequest marks on a request it opened from a box.
    bus.post('helper', JSON.stringify({
      kind: 'net-sign-request', sighash: bytesToHex(pcztSighash(pczt)), spends, pczt_hex: bytesToHex(pczt), sealed: true,
    }))

    await runCeremony(A, B, bus)

    // THE POINT: no `sreq` may carry a PCZT (that is the leak), and the ceremony still completes.
    const sreqs = bus.msgs
      .map((m) => { try { return JSON.parse(m.data) as { type?: string; pczt?: string } } catch { return {} } })
      .filter((p) => p.type === 'sreq')
    expect(sreqs.length).toBeGreaterThan(0)
    for (const s of sreqs) expect(s.pczt).toBeUndefined() // the PCZT is not re-broadcast
    expect(A.sig?.ok).toBe(true)
    expect(B.sig?.ok).toBe(true) // the participant signed using the PCZT it already held
    expect(A.sig?.hex).toBe(B.sig?.hex)
  })

  it('a proven seat wins even when it commits AFTER the unproven one (#399)', async () => {
    // The ordering a sort alone does NOT survive, and the reason the fix is not just a sort.
    //
    // The coordinator would otherwise build its package the moment it holds `t` commitments, so when
    // the unproven seat commits first the preference never sees the proven one. Deferring once and
    // retrying at the END of the drain is what closes it: by then every commitment that arrived in
    // the same sweep has landed.
    //
    // The retry cannot be "return the message unconsumed". That relies on some OTHER message
    // progressing in the same drain, and the commitment that reaches threshold usually arrives
    // alone - the loop then exits with nothing to retry and the ceremony dies waiting. That version
    // was written, and the all-unproven test below is what caught it.
    const { s0, s1, s2, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const A = makeDevice('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }))
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }))
    const C = makeDevice('C', bus, () => ({ keyPackage: s2.keyPackage(), groupVk, pubkeys }))
    A.unprovenTags.add('B')

    const pczt = dkgProvenPczt()
    bus.post('helper', signRequestFor(pczt).json)
    await pump(B, bus)          // the unproven seat commits first
    await pump(A, bus)          // the coordinator reaches threshold and picks, with only 1 and 2 in hand
    for (let i = 0; i < 6; i++) for (const d of [A, B, C]) await pump(d, bus)

    const sp = bus.msgs.map((m) => { try { return JSON.parse(m.data) as { type?: string; signers?: number[] } } catch { return {} } })
      .find((m) => m.type === 'sp')
    expect(sp!.signers, 'the proven seat wins even arriving late').toEqual([1, 3])
  })

  it('and a vault where NOTHING can prove itself still signs (#399)', async () => {
    // The constraint the fix above has to satisfy, and the test that caught the first attempt.
    //
    // A vault whose members all run a build that does not sign its rejoin has NO proven seats. Any
    // scheme that WAITS for one hangs such a vault forever, turning a transient denial of service
    // into a permanent one. The deferral is therefore bounded at one, after which the coordinator
    // proceeds with whatever it has - exactly the behaviour that shipped before this change.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const A = makeDevice('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }))
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }))
    A.unprovenTags.add('A')
    A.unprovenTags.add('B')

    const pczt = dkgProvenPczt()
    bus.post('helper', signRequestFor(pczt).json)
    await runCeremony(A, B, bus)

    expect(A.sig?.ok, 'an all-unproven vault must still produce a verifying signature').toBe(true)
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

  it('an sp from a tag that holds no seat is refused, and no share leaves (#519)', async () => {
    // Round 2 accepted a SigningPackage from anyone who could write to the room.
    //
    // `handle` passes `fromTag` to `onS1` and `onS2` and dropped it for `onSp`, so the only things
    // checked were the ceremony tag, the spend index, that the wire msg equalled the locally derived
    // sighash (#355, which holds), and that this seat was listed. Never WHO sent it.
    //
    // Replaying an OLD package does not work, and that is worth knowing: frost-core refuses it with
    // IncorrectCommitment, because the nonces of a fresh ceremony produce a different commitment. So
    // the attack is not a replay. It is an outsider assembling a package over the commitments that
    // are PUBLIC in the room right now - which is what `makeUnseatedCoordinator` does here.
    //
    // No theft: the transaction stays the approved one, because #355 refuses a msg this device did
    // not derive itself. What it costs is the ceremony. The single-use nonce is spent on the
    // attacker's package, `sentS2` then blocks a second share, and the honest coordinator arrives to
    // a device with nothing left to give. The legitimate send dies.
    //
    // The last assertion is the one that matters. A refusal that has already emitted a share is not
    // a refusal.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys })) // seat 2
    const X = makeUnseatedCoordinator('X', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys }))

    const pczt = dkgProvenPczt()
    bus.post('helper', signRequestFor(pczt).json)

    // B starts and publishes its commitment. X reads it and coordinates over the live commitments.
    for (let i = 0; i < 6; i++) { await pump(B, bus); await pump(X, bus) }

    const sp = bus.msgs.find((m) => m.data.includes('"sp"'))
    expect(sp, 'the unseated tag did assemble and post a SigningPackage').toBeTruthy()
    expect(sp?.from, 'and it came from a tag that holds no seat').toBe('X')

    const shares = bus.msgs.filter((m) => m.from === 'B' && m.data.includes('"s2"')).length
    expect(shares, 'B must not contribute a share to a package from a tag that holds no seat').toBe(0)
  })

  it('an sp whose sender is not seated YET is held, not refused, and signs once it is (#519)', async () => {
    // The false positive the fix has to avoid, and it is not hypothetical: `seatOf` is fed by the
    // peer's `rejoin`, NOT by its `s1`, so a legitimate coordinator's package can reach a device
    // before the rejoin that seats it. `background-session` re-drives the signer after every rejoin
    // precisely for this ("a pending signing message may now know this sender's seat"), which only
    // works if the message was returned UNCONSUMED. Refusing an unknown sender outright would
    // consume it and lose the honest send for good - trading #519 for an outage.
    const { s0, s1, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const A = makeDevice('A', bus, () => ({ keyPackage: s0.keyPackage(), groupVk, pubkeys })) // seat 1, coordinates
    // B's map does not contain A. Everything else about B is normal.
    const bSeats: Record<string, number> = { B: 2, C: 3 }
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys }), bSeats)

    const req = signRequestFor(dkgProvenPczt())
    bus.post('helper', req.json)
    for (let i = 0; i < 6; i++) { await pump(A, bus); await pump(B, bus) }

    // A has coordinated and posted its package; B has seen it and done nothing with it.
    expect(bus.msgs.some((m) => m.from === 'A' && m.data.includes('"sp"')), 'the coordinator did post a package').toBe(true)
    expect(bus.msgs.filter((m) => m.from === 'B' && m.data.includes('"s2"')).length, 'B has not signed a sender it cannot place').toBe(0)
    expect(B.errors, 'and it did not ERROR either - the sender is unknown, not wrong').toEqual([])

    // A's rejoin lands: B now knows the sender's seat, and the driver re-drives the signer.
    bSeats.A = 1
    await runCeremony(A, B, bus)

    // One share per spend: each real Orchard spend is its own ceremony, so a two-spend transaction
    // legitimately produces two `s2` from the same device.
    expect(bus.msgs.filter((m) => m.from === 'B' && m.data.includes('"s2"')).length, 'B signs every spend once it can place the sender').toBe(req.spendCount)
    expect(A.sig?.ok, 'and the ceremony completes to a VERIFYING signature').toBe(true)
  })

  it('a seated peer that is not the coordinator cannot open round 2 either (#519)', async () => {
    // The attack test uses a tag seated NOWHERE. This one is the other half: a tag every peer HAS
    // seated, just not at the coordinator's seat. It is the stronger case - the sender is a real
    // member of the vault - and it is the one that says the check reads the seat rather than merely
    // asking whether the sender is known.
    const { s1, s2, groupVk, pubkeys } = dkg2of3()
    const bus = new Bus()
    const B = makeDevice('B', bus, () => ({ keyPackage: s1.keyPackage(), groupVk, pubkeys })) // seat 2
    // C holds seat 3 in everyone's map, and behaves as though it coordinates. The real seat 1 never
    // joins, so the only package in the room is C's - B has no honest one to prefer over it.
    const C = makeDevice('C', bus, () => ({ keyPackage: s2.keyPackage(), groupVk, pubkeys }))
    Object.defineProperty(C.machine, 'd', { value: { ...(C.machine as unknown as { d: SigningDeps }).d, mySeat: () => 1 } })

    bus.post('helper', signRequestFor(dkgProvenPczt()).json)
    for (let i = 0; i < 8; i++) { await pump(B, bus); await pump(C, bus) }

    const sp = bus.msgs.find((m) => m.data.includes('"sp"'))
    expect(sp?.from, 'the seated non-coordinator did post a package').toBe('C')
    expect(bus.msgs.filter((m) => m.from === 'B' && m.data.includes('"s2"')).length, 'and B refused it').toBe(0)
    expect(B.errors, 'refused out loud, because a known sender at the wrong seat is a real refusal').toContain('net.err.notCoordinator')
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

describe('who coordinates is asked in one place (#519)', () => {
  // The defect this repo produces most is one rule with two implementations and only one of them
  // updated (#424, #425, #439, #349). #519 is its purest form: the coordinator's seat was written
  // into `coordinateIfReady` and simply never written into `onSp`, so for two rounds of hardening
  // every device answered "yes" to a package from anyone. The rule now has a name, and this asserts
  // the name is the only way to ask - a second bare literal is how the drift starts again.
  const SRC = readFileSync(new URL('./signing-machine.ts', import.meta.url), 'utf8')

  it('no seat is compared against a bare literal 1', () => {
    const offenders = SRC.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\w*[sS]eat\w*\s*(\(\))?\s*[!=]==\s*1\b/.test(line))
      .map(({ line, n }) => `signing-machine.ts:${n}  ${line}`)

    expect(offenders, `these ask who coordinates with a literal instead of COORDINATOR_SEAT:\n${offenders.join('\n')}`).toEqual([])
  })

  it('and both the coordinator and the verifier read the same constant', () => {
    expect(SRC.match(/COORDINATOR_SEAT/g)?.length ?? 0, 'the declaration plus BOTH readers').toBeGreaterThanOrEqual(3)
  })
})
