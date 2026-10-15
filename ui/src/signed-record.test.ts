/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { approvalDecision } from './wasm-pkg/konclave_wasm.js'
import { decideFor, hashSighash, readSigned, recordSigned, type RecordStore } from './signed-record'

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

describe('what this device signed, per vault and approval', () => {
  it('starts empty, and keeps a hash of each sighash with its expiry, never the sighash', async () => {
    const s = memory()
    expect(readSigned(s, 'v1', 'p1')).toEqual([])
    await recordSigned(s, 'v1', 'p1', A, ALIVE)
    const got = readSigned(s, 'v1', 'p1')
    expect(got).toEqual([{ h: await hashSighash(A), e: ALIVE }])
    expect([...s.data.values()].join('')).not.toContain(A)
  })

  it('records a transaction once, and keeps vaults and approvals apart', async () => {
    const s = memory()
    await recordSigned(s, 'v1', 'p1', A, ALIVE)
    await recordSigned(s, 'v1', 'p1', A.toUpperCase(), ALIVE)
    await recordSigned(s, 'v1', 'p2', B, ALIVE)
    await recordSigned(s, 'v2', 'p1', B, ALIVE)
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

describe('what a new transaction is, by the rule in WASM', () => {
  it('first, the same, a second while the first is alive, or after it expired', async () => {
    const s = memory()
    expect(await decideFor(s, 'v1', 'p1', A)).toEqual({ kind: 'first' })
    await recordSigned(s, 'v1', 'p1', A, ALIVE)
    expect(await decideFor(s, 'v1', 'p1', A)).toEqual({ kind: 'same' })
    expect(await decideFor(s, 'v1', 'p1', B)).toEqual({ kind: 'second', firstExpiry: ALIVE })
    const t = memory()
    await recordSigned(t, 'v1', 'p1', A, DEAD)
    expect(await decideFor(t, 'v1', 'p1', B)).toEqual({ kind: 'afterExpiry' })
  })
})
