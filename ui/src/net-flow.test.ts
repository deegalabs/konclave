/// <reference types="node" />
// Integration test of the /net multi-device flow, in one process, driving the exact WASM API the
// NetVault screen calls over the relay: a real 3-party DKG (2-of-3), then a signing ceremony over
// the REAL Orchard sighash NetVault now signs, with the on-device describeOutputs check. This closes
// the automated-test gap for the live /net ceremony (the relay transport + React rendering are the
// only parts not exercised here; the cryptography is end-to-end).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, {
  DkgSession,
  Coordinator,
  identifierBytes,
  participantRound1,
  participantRound2,
  verifyRedpallas,
  describeOutputs,
} from './wasm-pkg/konclave_wasm.js'
import { bytesEqual } from './net'
import { dkgProvenPczt, DKG_SIGHASH } from './demo-vector'

const hexToBytes = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)))

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

describe('/net multi-device flow (DKG → sign the real sighash → verify)', () => {
  it('a 2-of-3 DKG-born vault signs the real Orchard sighash and every device verifies', () => {
    const N = 3
    const T = 2
    const ids = [1, 2, 3].map((i) => identifierBytes(i))
    const sessions = ids.map((id) => new DkgSession(id, N, T))

    // Round 1: broadcast each device's public package to the others.
    const r1 = sessions.map((s) => s.round1Package())
    sessions.forEach((s, i) => r1.forEach((pkg, j) => { if (i !== j) s.addRound1(ids[j]!, pkg) }))

    // Round 2: each device produces one secret package per recipient; deliver to that recipient.
    sessions.forEach((s) => s.part2())
    sessions.forEach((s, i) => {
      for (let k = 0; k < s.round2Count(); k++) {
        const recip = s.round2Recipient(k)
        const pkg = s.round2Package(k)
        const j = ids.findIndex((id) => bytesEqual(id, recip))
        sessions[j]!.addRound2(ids[i]!, pkg)
      }
    })

    // Round 3: each device combines into its own share + the shared group key.
    sessions.forEach((s) => s.part3())

    // Every device derived the SAME group verifying key.
    const [s0, s1, s2] = sessions as [DkgSession, DkgSession, DkgSession]
    const [id0, id1] = ids as [Uint8Array, Uint8Array]
    const groupVk = s0.groupVk()
    expect(bytesEqual(s1.groupVk(), groupVk)).toBe(true)
    expect(bytesEqual(s2.groupVk(), groupVk)).toBe(true)

    // Sign the REAL Orchard sighash (the message /net now signs), with devices 1 and 2 (quorum = 2).
    const msg = hexToBytes(DKG_SIGHASH)
    const pubkeys = s0.pubkeys()
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

    // Both the coordinator and an independent re-check verify the aggregate over the real sighash.
    expect(coord.verify(sig)).toBe(true)
    expect(verifyRedpallas(groupVk, sp, seed, msg, sig)).toBe(true)
  })

  it('describeOutputs surfaces what the device is signing (recipient + value), as /net shows', () => {
    const outs = JSON.parse(describeOutputs(dkgProvenPczt())) as { address: string | null; value: number | null }[]
    const recipient = outs.find((o) => o.address !== null)
    expect(recipient?.value).toBe(100000) // 0.001 ZEC — what /net renders before signing
    expect(recipient?.address).toMatch(/^u1/) // a real Orchard unified address
  })
})
