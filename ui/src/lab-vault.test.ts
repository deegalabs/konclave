/// <reference types="node" />
// /lab/background-signer runs on a vault that exists only in the page (lab-vault.ts). These tests
// drive that vault whole with the network and every browser storage taken away AND counted, so "the
// lab never touches a real vault" is a run, not a reading of import lines. The import-line half is
// in lab-isolation.test.ts.
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import init, { ordinaryExpiry, pcztSighash, upgradeHeight } from './wasm-pkg/konclave_wasm.js'
import { honestExpiry, PINNED_NOW_MS, pinClock, unpinClock, withExpiry } from './test-vectors'
import { dkgProvenPczt } from './demo-vector'
import { bytesToHex } from './bytes'
import { hashSighash } from './signed-record'
import { ARM_TTL_MS } from './signing-gate'
import { LabVault } from './lab-vault'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})
// WASM reads the clock to decide which transactions it accepts; the vector is a NU6.3 one.
beforeAll(pinClock)
afterAll(unpinClock)

// NU6.3's consensus branch id: an oracle written out here, not read from the code under test.
const NU63 = 0x37a5165b
// The receiver the demo vector pays 1 ZEC to, as the device reads it.
const RECEIVER = 'eb843eb1c03fb58b1f844c511913d20c16a1d61df9cd2b826c0f7d6d82b7746c91b64bb0117134c34fec8b'

// Every way out of the page, stubbed and COUNTED: any touch fails the test that made it, in
// `afterEach`, even where the code under test swallowed the error the stub threw.
type Way = 'fetch' | 'WebSocket' | 'EventSource' | 'indexedDB' | 'localStorage' | 'sessionStorage'
const WAYS: Way[] = ['fetch', 'WebSocket', 'EventSource', 'indexedDB', 'localStorage', 'sessionStorage']
let touched: Record<Way, number>
const refuse = (w: Way) => (): never => { touched[w]++; throw new Error(`the lab used ${w}`) }
const counting = (w: Way) => new Proxy({}, { get: () => { touched[w]++; throw new Error(`the lab used ${w}`) } })
beforeEach(() => {
  touched = Object.fromEntries(WAYS.map((w) => [w, 0])) as Record<Way, number>
  const ways = {
    fetch: refuse('fetch'),
    WebSocket: refuse('WebSocket'),
    EventSource: refuse('EventSource'),
    indexedDB: counting('indexedDB'),
    localStorage: counting('localStorage'),
    sessionStorage: counting('sessionStorage'),
  }
  for (const [k, v] of Object.entries(ways)) vi.stubGlobal(k, v)
  // `crypto` passes through: the DKG and the nonces draw their randomness from it, as in a browser.
  vi.stubGlobal('window', { ...ways, crypto: globalThis.crypto })
})
afterEach(() => {
  vi.unstubAllGlobals()
  expect(touched).toEqual(Object.fromEntries(WAYS.map((w) => [w, 0])))
  vi.setSystemTime(PINNED_NOW_MS)
})

const noop = () => {}

describe('LabVault - the synthetic 2-of-3 behind /lab/background-signer', () => {
  it('seats three simulated devices, and two owners signing sign the test request to a verifying signature', async () => {
    const lab = new LabVault({ onChange: noop })
    await lab.seat()
    expect(lab.view().map((d) => d.seats)).toEqual([3, 3, 3])

    await lab.approve([1, 2])
    await lab.request()

    const [a, b, c] = lab.view()
    expect(a!.error).toBe('')
    expect(b!.error).toBe('')
    expect(a!.signature?.ok).toBe(true)
    expect(b!.signature?.ok).toBe(true)
    expect(a!.signature?.hex).toBe(b!.signature?.hex)
    // The device whose owner did not sign contributes nothing.
    expect(c!.signature).toBeNull()
    // Each signer recorded, in the product's record format (hashed) and in memory, the transaction
    // it read, with the expiry and the branch it read from the header, before its share left. Once,
    // however many spends the transaction has.
    const pczt = withExpiry(dkgProvenPczt())
    const h = await hashSighash(bytesToHex(pcztSighash(pczt)))
    for (const seat of [1, 2]) expect(lab.records(seat)).toEqual([{ h, e: honestExpiry(), b: NU63 }])
    expect(lab.records(3)).toEqual([])
  })

  it('the test transaction expires where the epoch table says, which is where an independent oracle says', () => {
    // The lab reads its expiry from WASM (the one table, #638); the oracle in test-vectors.ts is
    // written out apart from it. They agree at the pinned instant.
    expect(ordinaryExpiry()).toBe(honestExpiry())
  })

  it('each vault is a fresh DKG: two lab vaults share no group key', () => {
    const one = new LabVault({ onChange: noop })
    const two = new LabVault({ onChange: noop })
    expect(one.groupKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(one.groupKeyHex).not.toBe(two.groupKeyHex)
  })

  it('the approval is a real comparison: a request paying something other than what was approved is refused before any share moves', async () => {
    // Approve the same receiver, one zatoshi less: the request now pays something nobody approved.
    const lab = new LabVault({ onChange: noop, approval: [{ toReceiver: RECEIVER, amountZat: 100_000_000 - 1, memo: '' }] })
    await lab.seat()
    await lab.approve([1, 2])
    await lab.request()
    for (const d of lab.view().slice(0, 2)) {
      expect(d.error).toBe('net.err.notApproved')
      expect(d.signature).toBeNull()
    }
    expect(lab.records(1)).toEqual([])
    expect(lab.records(2)).toEqual([])
  })

  it("the owner's signature is what arms a device, and only within its window (OwnerSigning, as in the app)", async () => {
    const lab = new LabVault({ onChange: noop })
    await lab.seat()
    await lab.approve([1, 2])
    // The owners signed eleven minutes ago: their consent has lapsed, and no share goes in.
    vi.setSystemTime(PINNED_NOW_MS + ARM_TTL_MS + 60_000)
    await lab.request()
    for (const d of lab.view()) expect(d.signature).toBeNull()
    expect(lab.records(1)).toEqual([])
    expect(lab.records(2)).toEqual([])
  })

  // The page's `onChange` reads the vault it was given to. The sessions call back while the vault is
  // still being built, so an onChange that reads `lab` met an uninitialised binding: in a browser the
  // page threw on its first click, and every test passed because their onChange did nothing.
  it('an onChange that reads the vault works from the first callback, including during construction', async () => {
    const seen: number[] = []
    // The page's own shape: a const read from inside its own initialiser's callback.
    const lab: LabVault = new LabVault({ onChange: () => { seen.push(lab.view().length) } })
    await lab.seat()
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set([3]))
  })

  it('nothing on the bus names a real coordinator or relay: only the three lab devices and the lab coordinator speak', async () => {
    const lab = new LabVault({ onChange: noop })
    await lab.seat()
    await lab.approve([1, 2])
    await lab.request()
    const senders = new Set(lab.wire().map((m) => m.from))
    expect([...senders].sort()).toEqual(['lab-coordinator', 'lab-device-1', 'lab-device-2', 'lab-device-3'])
  })

  it('past the upgrade the devices refuse the NU6.3 test transaction, and the lab knows it is the vector, not the device', async () => {
    const before = new LabVault({ onChange: noop })
    expect(before.vectorPredatesUpgrade()).toBe(false)

    // A week past NU7's estimated activation: the device's table puts it well inside NU7.
    const activation = upgradeHeight()
    vi.setSystemTime(PINNED_NOW_MS + 75 * 1000 * (activation - (honestExpiry(PINNED_NOW_MS) - 40)) + 7 * 86_400_000)
    expect(ordinaryExpiry()).toBeGreaterThan(activation)
    const lab = new LabVault({ onChange: noop })
    expect(lab.vectorPredatesUpgrade()).toBe(true)
    await lab.seat()
    await lab.approve([1, 2])
    await lab.request()
    for (const d of lab.view().slice(0, 2)) {
      expect(['net.err.network', 'net.err.expiry']).toContain(d.error)
      expect(d.signature).toBeNull()
    }
  })
})
