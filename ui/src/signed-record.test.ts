/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { approvalDecision } from './wasm-pkg/konclave_wasm.js'
import { decideFor, hashSighash, readSigned, recordSigned, validBranch, type RecordStore } from './signed-record'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

function memory(): RecordStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
// A height far in the future: a transaction still valid by any clock.
const ALIVE = 4_000_000_000
// Block 1: long past by any clock after the network's anchor.
const DEAD = 1
// NU6.3's consensus branch id: an oracle written out here, not read from the code under test.
const NU63 = 0x37a5165b
// The last row of the table: nothing follows it, so a record under it ends at its own expiry (or never).
const NU7 = 0x77190ad9

describe('what this device signed, per vault and approval', () => {
  it('starts empty, and keeps a hash of each sighash with its expiry, never the sighash', async () => {
    const s = memory()
    expect(readSigned(s, 'v1', 'p1')).toEqual([])
    await recordSigned(s, 'v1', 'p1', A, ALIVE, NU63)
    const got = readSigned(s, 'v1', 'p1')
    expect(got).toEqual([{ h: await hashSighash(A), e: ALIVE, b: NU63 }])
    expect([...s.data.values()].join('')).not.toContain(A)
  })

  it('records a transaction once, and keeps vaults and approvals apart', async () => {
    const s = memory()
    await recordSigned(s, 'v1', 'p1', A, ALIVE, NU63)
    await recordSigned(s, 'v1', 'p1', A.toUpperCase(), ALIVE, NU63)
    await recordSigned(s, 'v1', 'p2', B, ALIVE, NU63)
    await recordSigned(s, 'v2', 'p1', B, ALIVE, NU63)
    expect(readSigned(s, 'v1', 'p1')).toHaveLength(1)
    expect(readSigned(s, 'v1', 'p2')).toHaveLength(1)
    expect(readSigned(s, 'v2', 'p1')).toHaveLength(1)
  })

  it('a record that cannot be read is an error, never "nothing signed"', () => {
    const s = memory()
    s.data.set('konclave.signed.v1', '{not json')
    expect(() => readSigned(s, 'v1', 'p1')).toThrow()
    const broken: RecordStore = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }
    expect(() => readSigned(broken, 'v1', 'p1')).toThrow()
  })

  // Each layer refuses a malformed record on its own, so none is safe only because another exists.
  it('a record that parses but is not an object of approvals is an error', () => {
    for (const raw of ['null', '[]', '7', '"x"']) {
      const s = memory()
      s.data.set('konclave.signed.v1', raw)
      expect(() => readSigned(s, 'v1', 'p1'), raw).toThrow('unreadable')
    }
  })
  it('an approval whose entries are not hash and height is an error', () => {
    for (const list of ['{"p1":"x"}', '{"p1":[{"h":1,"e":2}]}', '{"p1":[{"h":"aa","e":1.5}]}', '{"p1":[null]}']) {
      const s = memory()
      s.data.set('konclave.signed.v1', list)
      expect(() => readSigned(s, 'v1', 'p1'), list).toThrow('unreadable')
    }
  })
  it('the rule in WASM refuses a malformed record entry, never skips it', () => {
    expect(() => approvalDecision('nocolon', 'bb')).toThrow()
    expect(() => approvalDecision('aa:notanumber', 'bb')).toThrow()
  })
})

// An entry written before the branch was kept has no `b`. The rule in WASM reads it as NU6.3, and a
// device on the old bundle that never writes `b` is right about everything it can sign (#638).
describe('the branch of what this device signed', () => {
  it('an entry without a branch reads as NU6.3: a wire entry of two parts and of three decide alike', async () => {
    const old = memory()
    old.data.set('konclave.signed.v1', JSON.stringify({ p1: [{ h: await hashSighash(A), e: ALIVE }] }))
    const withB = memory()
    await recordSigned(withB, 'v1', 'p1', A, ALIVE, NU63)
    expect(readSigned(old, 'v1', 'p1')).toEqual([{ h: await hashSighash(A), e: ALIVE }])
    const a = await decideFor(old, 'v1', 'p1', B)
    expect(a).toEqual(await decideFor(withB, 'v1', 'p1', B))
    expect(a.kind).toBe('second')
    // And the dead ones agree too.
    const oldDead = memory()
    oldDead.data.set('konclave.signed.v1', JSON.stringify({ p1: [{ h: await hashSighash(A), e: DEAD }] }))
    expect(await decideFor(oldDead, 'v1', 'p1', B)).toEqual({ kind: 'afterExpiry' })
  })

  it('WASM takes h:e and h:e:b, and a branch this build does not know cannot be judged: it refuses', async () => {
    expect(JSON.parse(approvalDecision(`aa:${ALIVE}`, 'bb')).kind).toBe('second')
    expect(JSON.parse(approvalDecision(`aa:${ALIVE}:${NU63}`, 'bb')).kind).toBe('second')
    expect(() => approvalDecision(`aa:${ALIVE}:12345`, 'bb')).toThrow(/network upgrade/)
    expect(() => approvalDecision(`aa:${ALIVE}:x`, 'bb')).toThrow()
    // An unknown branch in the stored record refuses the decision as well, through the real path.
    const s = memory()
    s.data.set('konclave.signed.v1', JSON.stringify({ p1: [{ h: await hashSighash(A), e: ALIVE, b: 12345 }] }))
    await expect(decideFor(s, 'v1', 'p1', B)).rejects.toThrow()
  })

  it('a branch that is not a whole number is an unreadable record', () => {
    for (const b of ['"x"', '1.5', 'null']) {
      const s = memory()
      s.data.set('konclave.signed.v1', `{"p1":[{"h":"aa","e":1,"b":${b}}]}`)
      expect(() => readSigned(s, 'v1', 'p1'), b).toThrow('unreadable')
    }
  })

  it('refuses to record an entry with no usable branch, rather than let it read as NU6.3', async () => {
    for (const bad of [undefined, null, 0, -1, 1.5, NaN, 2 ** 32, '3', {}]) {
      const s = memory()
      await expect(recordSigned(s, 'v1', 'p1', A, ALIVE, bad as unknown as number), String(bad)).rejects.toThrow('[record]')
      expect(s.data.size, 'nothing was written').toBe(0)
    }
    expect([1, NU63, 2 ** 32 - 1].every(validBranch)).toBe(true)
    expect([undefined, 0, -3, 1.5, 2 ** 32, '1'].some(validBranch)).toBe(false)
  })

  it('a record that never stops counting gives no time: Second carries null, not a moment', async () => {
    const s = memory()
    await recordSigned(s, 'v1', 'p1', A, 0, NU7) // no expiry, and no upgrade after NU7
    const d = await decideFor(s, 'v1', 'p1', B)
    expect(d).toEqual({ kind: 'second', firstExpiry: 0, untilUnix: null, untilHeight: null, byEpoch: false })
  })

  it('one record that never stops counting hides the turn of another: no time at all', async () => {
    // The old rule skipped the record with no end and gave the OTHER one's moment, which a member
    // would wait for and find the warning still there.
    const s = memory()
    const soon = (await import('./test-vectors')).honestExpiry()
    await recordSigned(s, 'v1', 'p1', A, 0, NU7)
    await recordSigned(s, 'v1', 'p1', 'ee'.repeat(32), soon, NU63)
    const d = await decideFor(s, 'v1', 'p1', B)
    expect(d).toEqual({ kind: 'second', firstExpiry: soon, untilUnix: null, untilHeight: null, byEpoch: false })
  })

  it('Second carries the time the decision turns, from the same rule (no second reading of it)', async () => {
    const s = memory()
    // An expiry a few days out: the time is in the future, and is where the decision turns.
    const soon = (await import('./test-vectors')).honestExpiry()
    await recordSigned(s, 'v1', 'p1', A, soon, NU63)
    const d = await decideFor(s, 'v1', 'p1', B)
    expect(d.kind).toBe('second')
    if (d.kind !== 'second') return
    expect(d.untilUnix).toBeGreaterThan(Date.now() / 1000)
    expect(d.byEpoch).toBe(false)
  })
})

describe('what a new transaction is, by the rule in WASM', () => {
  it('first, the same, a second while the first is alive, or after it expired', async () => {
    const s = memory()
    expect(await decideFor(s, 'v1', 'p1', A)).toEqual({ kind: 'first' })
    await recordSigned(s, 'v1', 'p1', A, ALIVE, NU7)
    expect(await decideFor(s, 'v1', 'p1', A)).toEqual({ kind: 'same' })
    expect(await decideFor(s, 'v1', 'p1', B)).toEqual({ kind: 'second', firstExpiry: ALIVE, untilUnix: expect.any(Number), untilHeight: null, byEpoch: false })
    const t = memory()
    await recordSigned(t, 'v1', 'p1', A, DEAD, NU63)
    expect(await decideFor(t, 'v1', 'p1', B)).toEqual({ kind: 'afterExpiry' })
  })
})
