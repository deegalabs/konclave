import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import init, { DkgSession, identifierBytes } from './wasm-pkg/konclave_wasm.js'
import { bytesEqual } from './net'
import { bytesToHex } from './bytes'
import { signRejoin, verifyRejoin } from './room-auth'

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
