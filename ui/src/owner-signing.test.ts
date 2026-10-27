/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init from './wasm-pkg/konclave_wasm.js'
import { OwnerSigning } from './owner-signing'
import { ARM_TTL_MS } from './signing-gate'
import { readSigned, type RecordStore } from './signed-record'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

function memory(): RecordStore {
  const data = new Map<string, string>()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const ALIVE = 4_000_000_000
// NU6.3's consensus branch id: an oracle written out here, not read from the code under test.
const NU63 = 0x37a5165b
// NU7 is the last row of the table: nothing follows it, so a record under it ends at its own expiry.
// A record that stays alive for ever is under NU7; under NU6.3 it would end at the upgrade (#638).
const NU7 = 0x77190ad9

// The owner's side of signing on this device: one click covers one transaction, and what this device
// signed outlives a reload, a closed panel and a withdrawal, so a second transaction for the same
// approval is never signed without its owner confirming it.
describe('the owner signing on this device', () => {
  it('signs only with a live click, for the payment it was given for', async () => {
    const o = new OwnerSigning(memory())
    expect(o.allows('p1')).toBe(false)
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('refused')
    o.give('p1', Date.now())
    expect(o.allows('p1')).toBe(true)
    expect(o.allows('p2')).toBe(false)
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('ok')
  })

  it('a second transaction for an approval it signed is refused, across a reload and a withdrawal', async () => {
    const store = memory()
    const o = new OwnerSigning(store)
    o.give('p1', Date.now())
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('ok')
    await o.record(A, ALIVE, NU7)
    // The send went nowhere, every device withdrew, and the page reloaded: a new click...
    o.withdraw()
    const reloaded = new OwnerSigning(store)
    reloaded.give('p1', Date.now())
    // ...does not cover another transaction for the same approval while the first is alive.
    expect(await reloaded.claim('v1', 'p1', B, ALIVE)).toEqual('second')
    expect(reloaded.lastSecond).toEqual({ proposal: 'p1', firstExpiry: ALIVE, firstUntil: expect.any(Number), untilHeight: null, byEpoch: false, sighash: B })
    expect(reloaded.allows('p1'), 'the refused click is spent').toBe(false)
  })

  it('a second transaction goes through only after its owner signs again knowing it, and only once', async () => {
    const store = memory()
    const o = new OwnerSigning(store)
    o.give('p1', Date.now())
    await o.claim('v1', 'p1', A, ALIVE)
    await o.record(A, ALIVE, NU63)
    // B is refused and shown; the owner signs again having seen B.
    o.give('p1', Date.now())
    expect(await o.claim('v1', 'p1', B, ALIVE)).toBe('second')
    o.give('p1', Date.now(), { again: true })
    expect(await o.claim('v1', 'p1', B, ALIVE)).toBe('ok')
    await o.record(B, ALIVE, NU63)
    o.give('p1', Date.now())
    expect(await o.claim('v1', 'p1', 'ef'.repeat(32), ALIVE)).toBe('second')
  })

  it('signing again covers the transaction its owner was shown, not another one for the payment', async () => {
    const o = new OwnerSigning(memory())
    o.give('p1', Date.now())
    await o.claim('v1', 'p1', A, ALIVE)
    await o.record(A, ALIVE, NU63)
    o.give('p1', Date.now())
    expect(await o.claim('v1', 'p1', B, ALIVE)).toBe('second')
    o.give('p1', Date.now(), { again: true })
    // The coordinator brings C instead of the B that was shown: C is a second transaction, refused.
    expect(await o.claim('v1', 'p1', 'ef'.repeat(32), ALIVE)).toBe('second')
  })

  it('the same transaction again (a restarted ceremony) passes', async () => {
    const o = new OwnerSigning(memory())
    o.give('p1', Date.now())
    await o.claim('v1', 'p1', A, ALIVE)
    await o.record(A, ALIVE, NU63)
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('ok')
  })

  it('a record it cannot read refuses, never signs', async () => {
    const broken: RecordStore = { getItem: () => { throw new Error('blocked') }, setItem: () => {} }
    const o = new OwnerSigning(broken)
    o.give('p1', Date.now())
    // Its own answer, so the screen does not say "already signed" for a record it could not read.
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('unreadable')
    expect(o.allows('p1'), 'and the click is spent').toBe(false)
  })

  it('a share asked for after its owner withdrew is not recorded, so it does not leave', async () => {
    const o = new OwnerSigning(memory())
    o.give('p1', Date.now())
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('ok')
    o.withdraw()
    await expect(o.record(A, ALIVE, NU63)).rejects.toThrow('[withdrawn]')
  })

  it('a share asked for after the window of the signature closed is not recorded', async () => {
    let now = 1_000_000
    const o = new OwnerSigning(memory(), () => now)
    o.give('p1', now)
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('ok')
    // The device slept; the screen's timer never ran; the package arrives late.
    now += ARM_TTL_MS + 1
    await expect(o.record(A, ALIVE, NU63)).rejects.toThrow('[withdrawn]')
  })

  it('a signature given for another payment between the claim and the share lets nothing leave for the first', async () => {
    const store = memory()
    const o = new OwnerSigning(store)
    o.give('p1', Date.now())
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('ok')
    o.give('p2', Date.now())
    await expect(o.record(A, ALIVE, NU63)).rejects.toThrow('[withdrawn]')
    expect(readSigned(store, 'v1', 'p1')).toEqual([])
    expect(readSigned(store, 'v1', 'p2')).toEqual([])
  })

  it('records only the transaction it claimed, under the approval it claimed it for', async () => {
    const store = memory()
    const o = new OwnerSigning(store)
    o.give('p1', Date.now())
    expect(await o.claim('v1', 'p1', A, ALIVE)).toBe('ok')
    await expect(o.record(B, ALIVE, NU63)).rejects.toThrow('[withdrawn]')
    // The screen moved to another payment meanwhile: the record still belongs to the claimed one.
    await o.record(A, ALIVE, NU63)
    expect(readSigned(store, 'v1', 'p1').length).toBe(1)
    expect(readSigned(store, 'v1', 'p2')).toEqual([])
  })
})
