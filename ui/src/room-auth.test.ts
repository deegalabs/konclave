import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import init, { DkgSession, identifierBytes } from './wasm-pkg/konclave_wasm.js'
import { bytesEqual } from './net'
import { bytesToHex } from './bytes'
import { signRejoin, verifyRejoin, rejoinIsProven } from './room-auth'

beforeAll(async () => {
  await init(readFileSync(fileURLToPath(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url))))
})

// A real 2-of-3 DKG in one process, so we have a device's KeyPackage (seat 1) and the shared
// PublicKeyPackage that carries every seat's verifying_share.
function dkg2of3() {
  const ids = [1, 2, 3].map((i) => identifierBytes(i))
  const sessions = ids.map((id) => new DkgSession(id, 3, 2))
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
  const [s0] = sessions as [DkgSession, DkgSession, DkgSession]
  return { s0, groupVk: s0.groupVk(), pubkeys: s0.pubkeys() }
}

describe('room-auth (#392) — a rejoin is bound to its seat, vault, and tag', () => {
  it('seat 1 signs a rejoin that verifies; a forgery, wrong seat, or replayed tag does not', () => {
    const { s0, groupVk, pubkeys } = dkg2of3()
    const gvk = bytesToHex(groupVk)
    const sig = signRejoin(s0.keyPackage(), 1, gvk, 'tag-a') // seat 1's own share

    expect(verifyRejoin(pubkeys, 1, gvk, 'tag-a', sig)).toBe(true) // the legitimate holder
    expect(verifyRejoin(pubkeys, 2, gvk, 'tag-a', sig)).toBe(false) // cannot claim a different seat
    expect(verifyRejoin(pubkeys, 1, gvk, 'tag-b', sig)).toBe(false) // cannot be replayed under a new tag
    expect(verifyRejoin(pubkeys, 1, gvk, 'tag-a', 'ff'.repeat(64))).toBe(false) // a garbage signature
  })
})

// The whole decision, not half of it. #424 was not a missing primitive - `verifyRejoin` existed and
// was correct - it was one of the two ceremony drivers never calling it. Sharing only the primitive
// leaves each caller free to pass the group key or the tag in the wrong place, so the composed
// check is what both now use, and this is what pins it.
describe('rejoinIsProven — the check both ceremony drivers share (#424)', () => {
  it('accepts the seat-holder\'s own signed rejoin', () => {
    const { s0, groupVk, pubkeys } = dkg2of3()
    const sig = signRejoin(s0.keyPackage(), 1, bytesToHex(groupVk), 'tag-a')
    expect(rejoinIsProven({ groupVk, pubkeys }, 1, 'tag-a', sig)).toBe(true)
  })

  it('rejects the hijack: the same signature replayed from another tag', () => {
    // This is the A4 seat-hijack. An attacker reads seat 1's rejoin off the room and re-sends it
    // under their own tag to evict the real holder. The tag is inside the signed message, so it
    // does not verify - and an unproven rejoin never evicts.
    const { s0, groupVk, pubkeys } = dkg2of3()
    const stolen = signRejoin(s0.keyPackage(), 1, bytesToHex(groupVk), 'tag-a')
    expect(rejoinIsProven({ groupVk, pubkeys }, 1, 'attacker-tag', stolen)).toBe(false)
  })

  it('rejects a rejoin with no signature at all, which is what /net used to send', () => {
    const { groupVk, pubkeys } = dkg2of3()
    expect(rejoinIsProven({ groupVk, pubkeys }, 1, 'tag-a', undefined)).toBe(false)
  })

  it('never throws on malformed input - it answers false', () => {
    // It is called on every rejoin that arrives from a relay room, i.e. on attacker-controlled
    // input. A throw there would take down message handling, which is a cheaper attack than the
    // hijack it is meant to stop.
    const { groupVk, pubkeys } = dkg2of3()
    const mat = { groupVk, pubkeys }
    for (const bad of [null, 42, {}, [], 'zzzz', '', 'ff'.repeat(64)]) {
      expect(rejoinIsProven(mat, 1, 'tag-a', bad), `input ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('rejects a signature from a DIFFERENT vault, same seat and tag', () => {
    // Two vaults, one attacker who is a real member of vault B claiming seat 1 of vault A. The
    // group key is inside the signed message, so it does not carry across.
    const a = dkg2of3()
    const b = dkg2of3()
    const sigB = signRejoin(b.s0.keyPackage(), 1, bytesToHex(b.groupVk), 'tag-a')
    expect(rejoinIsProven({ groupVk: a.groupVk, pubkeys: a.pubkeys }, 1, 'tag-a', sigB)).toBe(false)
  })
})
