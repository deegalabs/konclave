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
import { bytesEqual } from './net'
import { dkgProvenPczt, DKG_SIGHASH } from './demo-vector'

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
  it('a 2-of-3 DKG-born vault signs the real Orchard sighash and every device verifies', () => {
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

  it('signs under the PCZT Orchard randomizer (alpha) — the real-transaction path', () => {
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

  it('describeOutputs surfaces what the device is signing (recipient + value), as /net shows', () => {
    const outs = JSON.parse(describeOutputs(dkgProvenPczt())) as { address: string | null; value: number | null }[]
    const recipient = outs.find((o) => o.address !== null)
    expect(recipient?.value).toBe(100000) // 0.001 ZEC — what /net renders before signing
    expect(recipient?.address).toMatch(/^u1/) // a real Orchard unified address
  })
})
