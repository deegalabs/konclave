/// <reference types="node" />
// Integration test of the /net multi-device flow, in one process, driving the exact WASM API the
// NetVault screen calls over the relay: a real 3-party DKG (2-of-3), then a signing ceremony over
// the REAL Orchard sighash NetVault signs, with the on-device describeOutputs check — and the
// real-transaction path that signs under the PCZT's Orchard randomizer (alpha), the piece a real
// broadcast needs. Closes the automated-test gap for the live /net ceremony (only the relay
// transport + React rendering are not exercised here; the cryptography is end-to-end).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, {
  DkgSession,
  Coordinator,
  identifierBytes,
  participantRound1,
  participantRound2,
  participantRound2WithRandomizer,
  verifyRedpallas,
  describeOutputs,
} from './wasm-pkg/konclave_wasm.js'
import { bytesEqual, b64, unb64 } from './net'
import { dkgProvenPczt, DKG_SIGHASH } from './demo-vector'
import { parseSignRequest, buildSignResponse, bytesToHex, RESPONSE_KIND } from './net-sign'

const hexToBytes = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)))

// The alpha of Konclave's real mainnet DKG-vault spend (aab00f90…) — a valid Orchard randomizer.
const DKG_ALPHA = hexToBytes('b2ad61e8bf0de877dd01c52356526adf39b036ffed2e0217ece19407e1717624')

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

// Run a real 3-party DKG (2-of-3) in one process, exactly as /net does across devices over the
// relay. Returns the two quorum sessions, their ids, and the shared group material.
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
  const [id0, id1] = ids as [Uint8Array, Uint8Array]
  return { s0, s1, s2, id0, id1, groupVk: s0.groupVk(), pubkeys: s0.pubkeys() }
}

describe('/net multi-device flow (DKG → sign → verify)', () => {
  it('seed-based group signing works (the /signer demo path): a 2-of-3 signs and verifies', () => {
    const { s0, s1, s2, id0, id1, groupVk, pubkeys } = dkg2of3()

    // Every device derived the SAME group verifying key.
    expect(bytesEqual(s1.groupVk(), groupVk)).toBe(true)
    expect(bytesEqual(s2.groupVk(), groupVk)).toBe(true)

    // Sign the REAL Orchard sighash (the message /net signs), with devices 1 and 2 (quorum = 2).
    const msg = hexToBytes(DKG_SIGHASH)
    const a = participantRound1(s0.keyPackage())
    const b = participantRound1(s1.keyPackage())
    const coord = new Coordinator(groupVk, pubkeys, msg)
    coord.addCommitment(id0, a.commitment())
    coord.addCommitment(id1, b.commitment())
    coord.prepare()
    const sp = coord.signingPackage()
    const seed = coord.seed()
    coord.addShare(id0, participantRound2(sp, a.nonces(), s0.keyPackage(), seed))
    coord.addShare(id1, participantRound2(sp, b.nonces(), s1.keyPackage(), seed))
    const sig = coord.aggregate()

    expect(coord.verify(sig)).toBe(true)
    expect(verifyRedpallas(groupVk, sp, seed, msg, sig)).toBe(true)
  })

  it('the /net path: a 2-of-3 signs under the PCZT alpha and verifies under ak+alpha', () => {
    // A DKG-born vault signs the sighash under a SPECIFIC Orchard alpha (from extractRandomizers),
    // not a commitment-derived seed. This is what lets the signature be injected into the PCZT and
    // broadcast. The signature must verify under ak+alpha — the exact check an Orchard spend passes.
    const { s0, s1, id0, id1, groupVk, pubkeys } = dkg2of3()
    const msg = hexToBytes(DKG_SIGHASH)
    const a = participantRound1(s0.keyPackage())
    const b = participantRound1(s1.keyPackage())
    const coord = new Coordinator(groupVk, pubkeys, msg)
    coord.addCommitment(id0, a.commitment())
    coord.addCommitment(id1, b.commitment())
    coord.prepare()
    const sp = coord.signingPackage()
    coord.addShare(id0, participantRound2WithRandomizer(sp, a.nonces(), s0.keyPackage(), DKG_ALPHA))
    coord.addShare(id1, participantRound2WithRandomizer(sp, b.nonces(), s1.keyPackage(), DKG_ALPHA))
    const sig = coord.aggregateWithRandomizer(DKG_ALPHA)

    // Verifies under the key randomized by this alpha...
    expect(coord.verifyWithRandomizer(DKG_ALPHA, sig)).toBe(true)
    // ...and a DIFFERENT alpha does not — the randomizer binds the signature to the spend.
    const otherAlpha = hexToBytes('557c4ff828ed56eb33e8ba7f508a43915338ccf3ad71d1ecedc98e6e861bfc0f')
    expect(coord.verifyWithRandomizer(otherAlpha, sig)).toBe(false)
  })

  it('a restored share signs again (signing after restore), via the same path /net uses', () => {
    // Persistence saves each device's material as a bundle (KeyPackage, pubkeys, group key);
    // a reload restores it. Prove that the RESTORED bytes alone — no live DkgSession — run the
    // exact ceremony /net runs today (the randomizer path, under the PCZT alpha) and verify. This
    // closes the "signing-after-restore" gap: a reloaded device is a full signer again.
    const { s0, s1, id0, id1 } = dkg2of3()
    const save = (s: DkgSession) => JSON.stringify({ kp: b64(s.keyPackage()), pubkeys: b64(s.pubkeys()), gvk: b64(s.groupVk()) })
    const restore = (json: string) => {
      const b = JSON.parse(json) as { kp: string; pubkeys: string; gvk: string }
      return { kp: unb64(b.kp), pubkeys: unb64(b.pubkeys), gvk: unb64(b.gvk) }
    }
    const r0 = restore(save(s0)) // device 1 after a reload
    const r1 = restore(save(s1)) // device 2 after a reload

    const msg = hexToBytes(DKG_SIGHASH)
    const a = participantRound1(r0.kp)
    const b = participantRound1(r1.kp)
    const coord = new Coordinator(r0.gvk, r0.pubkeys, msg)
    coord.addCommitment(id0, a.commitment())
    coord.addCommitment(id1, b.commitment())
    coord.prepare()
    const sp = coord.signingPackage()
    coord.addShare(id0, participantRound2WithRandomizer(sp, a.nonces(), r0.kp, DKG_ALPHA))
    coord.addShare(id1, participantRound2WithRandomizer(sp, b.nonces(), r1.kp, DKG_ALPHA))
    const sig = coord.aggregateWithRandomizer(DKG_ALPHA)
    expect(coord.verifyWithRandomizer(DKG_ALPHA, sig)).toBe(true)
  })

  it('sign-after-restore via the storage bundle + the seat re-announced on rejoin', () => {
    // The exact contract NetVault + storage.ts implement: a device persists {KeyPackage, group
    // PublicKeyPackage, SEAT} (encrypted). After a reload there is NO live DkgSession — the device
    // rebuilds its FROST identifier FROM the seat it re-announces over the relay (`rejoin`), then
    // signs. This test drives that path end to end from the bundle bytes alone, so the seat->id
    // reconstruction is exercised (the existing restore test hardcodes the ids).
    const { s0, s1, groupVk } = dkg2of3()

    // What saveVault stores per device (seat 1 and seat 2 of the 2-of-3), then the sessions vanish.
    const save = (s: DkgSession, seat: number) =>
      JSON.stringify({ kp: b64(s.keyPackage()), pubkeys: b64(s.pubkeys()), gvk: b64(s.groupVk()), seat })
    const bundleA = save(s0, 1)
    const bundleB = save(s1, 2)
    const restore = (json: string) => {
      const b = JSON.parse(json) as { kp: string; pubkeys: string; gvk: string; seat: number }
      return { kp: unb64(b.kp), pubkeys: unb64(b.pubkeys), gvk: unb64(b.gvk), seat: b.seat }
    }
    const a = restore(bundleA)
    const b = restore(bundleB)

    // The group identity survives the round-trip...
    expect(bytesEqual(a.gvk, groupVk)).toBe(true)

    // ...and each device rebuilds its identifier from the seat announced on rejoin (tag -> seat -> id).
    const idA = identifierBytes(a.seat)
    const idB = identifierBytes(b.seat)

    const msg = hexToBytes(DKG_SIGHASH)
    const r1a = participantRound1(a.kp)
    const r1b = participantRound1(b.kp)
    const coord = new Coordinator(a.gvk, a.pubkeys, msg)
    coord.addCommitment(idA, r1a.commitment())
    coord.addCommitment(idB, r1b.commitment())
    coord.prepare()
    const sp = coord.signingPackage()
    coord.addShare(idA, participantRound2WithRandomizer(sp, r1a.nonces(), a.kp, DKG_ALPHA))
    coord.addShare(idB, participantRound2WithRandomizer(sp, r1b.nonces(), b.kp, DKG_ALPHA))
    const sig = coord.aggregateWithRandomizer(DKG_ALPHA)

    // A verifying Orchard signature from two reloaded devices — no DKG redo.
    expect(coord.verifyWithRandomizer(DKG_ALPHA, sig)).toBe(true)
  })

  it('describeOutputs surfaces what the device is signing (recipient + value), as /net shows', () => {
    const outs = JSON.parse(describeOutputs(dkgProvenPczt())) as { address: string | null; value: number | null }[]
    const recipient = outs.find((o) => o.address !== null)
    expect(recipient?.value).toBe(100000000) // the Ironwood vector's recipient output, as /net renders it
    expect(recipient?.address).toMatch(/^u(test)?1/) // a real unified address (this vector is testnet)
  })

  it('Architecture B: a device parses a helper sign-request, signs, and builds a valid response', () => {
    // The helper (orchestrator net_send) publishes a request into the relay room, exactly this
    // JSON shape (snake_case pczt_hex). A device parses it strictly, confirms what it pays, runs
    // the ceremony under the request's alpha, and publishes back the response the helper's
    // `into_sigs` consumes. This is the browser end of the demo -> real broadcast path.
    const requestJson = JSON.stringify({
      kind: 'net-sign-request',
      sighash: DKG_SIGHASH,
      spends: [{ index: 0, alpha: bytesToHex(DKG_ALPHA) }],
      pczt_hex: bytesToHex(dkgProvenPczt()),
    })

    const req = parseSignRequest(requestJson)
    expect(req).not.toBeNull()
    expect(req!.spends).toHaveLength(1)
    // The device can confirm what it is about to sign, straight from the request's PCZT.
    const outs = JSON.parse(describeOutputs(hexToBytes(req!.pcztHex))) as { value: number | null }[]
    expect(outs.find((o) => o.value === 100000000)).toBeDefined()

    // Run the 2-of-3 ceremony for the requested spend, under the request's own alpha.
    const { s0, s1, id0, id1, groupVk, pubkeys } = dkg2of3()
    const alpha = hexToBytes(req!.spends[0]!.alpha)
    const msg = hexToBytes(req!.sighash)
    const a = participantRound1(s0.keyPackage())
    const b = participantRound1(s1.keyPackage())
    const coord = new Coordinator(groupVk, pubkeys, msg)
    coord.addCommitment(id0, a.commitment())
    coord.addCommitment(id1, b.commitment())
    coord.prepare()
    const sp = coord.signingPackage()
    coord.addShare(id0, participantRound2WithRandomizer(sp, a.nonces(), s0.keyPackage(), alpha))
    coord.addShare(id1, participantRound2WithRandomizer(sp, b.nonces(), s1.keyPackage(), alpha))
    const sig = coord.aggregateWithRandomizer(alpha)
    expect(coord.verifyWithRandomizer(alpha, sig)).toBe(true)

    // Build the response the helper consumes, and round-trip it.
    const responseJson = buildSignResponse([{ index: req!.spends[0]!.index, sig: bytesToHex(sig) }])
    const resp = JSON.parse(responseJson) as { kind: string; sigs: { index: number; sig: string }[] }
    expect(resp.kind).toBe(RESPONSE_KIND)
    expect(resp.sigs).toHaveLength(1)
    expect(resp.sigs[0]!.index).toBe(0)
    expect(hexToBytes(resp.sigs[0]!.sig)).toHaveLength(64)
  })

  it('Architecture B multi-spend: two spends -> two ceremonies -> one response the helper accepts', () => {
    // A multi-note PCZT carries several real Orchard spends, each with its OWN randomizer (alpha)
    // but the SAME sighash. Each spend needs a FRESH FROST ceremony (nonces are never reused across
    // signatures). Prove the browser produces one valid signature per spend and assembles the
    // multi-sig response the helper's `into_sigs` count-validates and maps back by index. This is
    // the browser crypto for the multi-spend path; the live relay sequencing in NetVault is the
    // remaining (e2e-proven) piece, exactly like the single-spend live ceremony.
    const { s0, s1, id0, id1, groupVk, pubkeys } = dkg2of3()
    const msg = hexToBytes(DKG_SIGHASH)
    const alphas = [
      DKG_ALPHA,
      hexToBytes('557c4ff828ed56eb33e8ba7f508a43915338ccf3ad71d1ecedc98e6e861bfc0f'),
    ]

    // One independent ceremony per spend — fresh round-1 nonces each time.
    const sigs = alphas.map((alpha, index) => {
      const a = participantRound1(s0.keyPackage())
      const b = participantRound1(s1.keyPackage())
      const coord = new Coordinator(groupVk, pubkeys, msg)
      coord.addCommitment(id0, a.commitment())
      coord.addCommitment(id1, b.commitment())
      coord.prepare()
      const sp = coord.signingPackage()
      coord.addShare(id0, participantRound2WithRandomizer(sp, a.nonces(), s0.keyPackage(), alpha))
      coord.addShare(id1, participantRound2WithRandomizer(sp, b.nonces(), s1.keyPackage(), alpha))
      const sig = coord.aggregateWithRandomizer(alpha)
      // Each spend verifies under its OWN alpha, and not the other's — the randomizer binds each
      // signature to its specific spend.
      expect(coord.verifyWithRandomizer(alpha, sig)).toBe(true)
      const other = alphas[1 - index]!
      expect(coord.verifyWithRandomizer(other, sig)).toBe(false)
      return { index, sig: bytesToHex(sig) }
    })

    // The response carries one sig per spend, indexed — exactly what `into_sigs` maps back.
    const responseJson = buildSignResponse(sigs)
    const resp = JSON.parse(responseJson) as { kind: string; sigs: { index: number; sig: string }[] }
    expect(resp.kind).toBe(RESPONSE_KIND)
    expect(resp.sigs).toHaveLength(2)
    expect(resp.sigs.map((sr) => sr.index)).toEqual([0, 1])
    expect(resp.sigs.every((sr) => hexToBytes(sr.sig).length === 64)).toBe(true)
  })

  it('parseSignRequest rejects a wrong-kind or malformed message', () => {
    expect(parseSignRequest('not json')).toBeNull()
    expect(parseSignRequest(JSON.stringify({ kind: 'something-else' }))).toBeNull()
    expect(parseSignRequest(JSON.stringify({ kind: 'net-sign-request', sighash: 'x' }))).toBeNull()
  })
})
