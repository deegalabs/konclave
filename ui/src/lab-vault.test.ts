/// <reference types="node" />
// /lab/background-signer runs on a vault that exists only in the page (lab-vault.ts). These tests
// drive that vault whole, with the network and IndexedDB taken away, so "the lab never touches a
// real vault" is a run, not a reading of import lines. The import-line half is in
// lab-isolation.test.ts.
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import init, { pcztSighash } from './wasm-pkg/konclave_wasm.js'
import { pinClock, unpinClock, withExpiry } from './test-vectors'
import { dkgProvenPczt } from './demo-vector'
import { bytesToHex } from './bytes'
import { LabVault } from './lab-vault'
import { makeSigningGate, type SigningMode } from './signing-gate'

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})
// WASM reads the clock to decide which transactions it accepts; the vector is a NU6.3 one.
beforeAll(pinClock)
afterAll(unpinClock)

// No network and no IndexedDB for any test here: a call to either fails the test where it happens.
let fetches = 0
beforeEach(() => {
  fetches = 0
  vi.stubGlobal('fetch', () => { fetches++; throw new Error('the lab made a network request') })
  vi.stubGlobal('WebSocket', function () { throw new Error('the lab opened a socket') })
  vi.stubGlobal('EventSource', function () { throw new Error('the lab opened a stream') })
  vi.stubGlobal('indexedDB', undefined)
})
afterEach(() => { vi.unstubAllGlobals() })

const open = () => true
// The receiver the demo vector pays 1 ZEC to, as the device reads it.
const RECEIVER = 'eb843eb1c03fb58b1f844c511913d20c16a1d61df9cd2b826c0f7d6d82b7746c91b64bb0117134c34fec8b'

describe('LabVault - the synthetic 2-of-3 behind /lab/background-signer', () => {
  it('seats three simulated devices, and two approvals sign the test request to a verifying signature', async () => {
    const lab = new LabVault({ gate: open, onChange: () => {} })
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
    // The device whose owner did not approve contributes nothing.
    expect(c!.signature).toBeNull()
    // Each signer recorded, in memory, the transaction it read before its share left.
    const sighash = bytesToHex(pcztSighash(withExpiry(dkgProvenPczt())))
    expect(lab.records(1).map((r) => r.sighash)).toEqual([sighash])
    expect(lab.records(2).map((r) => r.sighash)).toEqual([sighash])
    expect(fetches).toBe(0)
  })

  // The page's `onChange` reads the vault it was given to. The sessions call back while the vault is
  // still being built, so an onChange that reads `lab` met an uninitialised binding: in a browser the
  // page threw on its first click, and every test above passed because their onChange did nothing.
  it('an onChange that reads the vault works from the first callback, including during construction', async () => {
    const seen: number[] = []
    // The page's own shape: a const read from inside its own initialiser's callback.
    const lab: LabVault = new LabVault({ gate: open, onChange: () => { seen.push(lab.view().length) } })
    await lab.seat()
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set([3]))
  })

  it('each vault is a fresh DKG: two lab vaults share no group key', () => {
    const one = new LabVault({ gate: open, onChange: () => {} })
    const two = new LabVault({ gate: open, onChange: () => {} })
    expect(one.groupKeyHex).toMatch(/^[0-9a-f]{64}$/)
    expect(one.groupKeyHex).not.toBe(two.groupKeyHex)
  })

  it('the approval is a real comparison: a request paying something other than what was approved is refused before any share moves', async () => {
    // Approve the same receiver, one zatoshi less: the request now pays something nobody approved.
    const lab = new LabVault({ gate: open, onChange: () => {}, approval: [{ toReceiver: RECEIVER, amountZat: 100_000_000 - 1, memo: '' }] })
    await lab.seat()
    await lab.approve([1, 2])
    await lab.request()
    for (const d of lab.view().slice(0, 2)) {
      expect(d.error).toBe('net.err.notApproved')
      expect(d.signature).toBeNull()
    }
    expect(lab.records(1)).toEqual([])
    expect(lab.records(2)).toEqual([])
    expect(fetches).toBe(0)
  })

  it('manual mode: the request waits until the payment is armed, then signs', async () => {
    let armed = false
    const manual: SigningMode = 'manual'
    const gate = makeSigningGate({ mode: () => manual, isApproved: () => true, isArmed: () => armed })
    const lab = new LabVault({ gate, onChange: () => {} })
    await lab.seat()
    await lab.approve([1, 2])
    await lab.request()
    expect(lab.view()[0]!.signature).toBeNull()
    armed = true
    await lab.retry()
    expect(lab.view()[0]!.signature?.ok).toBe(true)
    expect(lab.view()[1]!.signature?.ok).toBe(true)
    // And the device whose owner did not approve still has not signed.
    expect(lab.view()[2]!.signature).toBeNull()
  })

  it('nothing on the bus names a real coordinator or relay: only the three lab devices and the lab coordinator speak', async () => {
    const lab = new LabVault({ gate: open, onChange: () => {} })
    await lab.seat()
    await lab.approve([1, 2])
    await lab.request()
    const senders = new Set(lab.wire().map((m) => m.from))
    expect([...senders].sort()).toEqual(['lab-coordinator', 'lab-device-1', 'lab-device-2', 'lab-device-3'])
  })
})
