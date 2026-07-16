/// <reference types="node" />
// End-to-end test of the FROST<->PCZT bridge across the JS boundary (slice 2). This exercises the
// real wasm-pack artifact the browser loads — describeOutputs / extractRandomizers / injectSigs —
// against the same real mainnet golden vectors that pin the native signer (audit C6). It proves the
// wire encoding round-trips in JavaScript, not just that Rust compiles.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { describeOutputs, extractRandomizers, injectSigs } from './wasm-pkg/konclave_wasm.js'

const vec = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../konclave-wasm/tests/vectors/${name}`, import.meta.url)))

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// DKG-vault self-send `aab00f90…`: the sighash the broadcast signature commits to, and the vault UA.
const DKG_SIGHASH = hex('f30f233e7736ce57368b78cd2d5cd197fc850a8217c3da1a2de3653b900fb0aa')
const DKG_ALPHA1 = 'b2ad61e8bf0de877dd01c52356526adf39b036ffed2e0217ece19407e1717624'
const DKG_ADDR =
  'u10m0pn6tmvaa6e4sm6g4r7unhvgjt5s7239ya43wxrjhld0ejnznau8kyrjnp6wv7qcfjddaq8rumrjcfd0xv87du346eu08h758r3acx'

beforeAll(async () => {
  const wasmBytes = readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url))
  await init(wasmBytes)
})

describe('FROST<->PCZT bridge over the JS boundary', () => {
  const proven = vec('dkg_single_spend.proven.pczt')
  const signed = vec('dkg_single_spend.signed.pczt')
  const sig1 = vec('dkg_single_spend.sig1.raw')

  it('describeOutputs reads the recipient the human must confirm, and marks change', () => {
    const outs = JSON.parse(describeOutputs(proven)) as { address: string | null; value: number | null }[]
    expect(outs).toHaveLength(2)
    const recipients = outs.filter((o) => o.address !== null)
    expect(recipients).toEqual([{ address: DKG_ADDR, value: 100000 }])
    // the other output is change: no user-facing address
    expect(outs.some((o) => o.address === null)).toBe(true)
  })

  it('extractRandomizers yields the real spend index and alpha', () => {
    const buf = extractRandomizers(proven)
    expect(buf.length).toBe(36) // one 36-byte record: u32 index + 32-byte alpha
    const index = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true)
    expect(index).toBe(1) // the real Orchard spend sits at action index 1
    expect(toHex(buf.slice(4, 36))).toBe(DKG_ALPHA1)
  })

  it('injectSigs reproduces the exact PCZT that was broadcast to mainnet', () => {
    // one 68-byte signature record: u32-LE index 1, then the 64-byte broadcast signature
    const sigs = new Uint8Array(68)
    new DataView(sigs.buffer).setUint32(0, 1, true)
    sigs.set(sig1, 4)
    const out = injectSigs(proven, DKG_SIGHASH, sigs)
    expect(toHex(out)).toBe(toHex(signed))
  })

  it('injectSigs rejects a signature that does not verify', () => {
    const sigs = new Uint8Array(68)
    new DataView(sigs.buffer).setUint32(0, 1, true) // index 1, sig left as zeros
    expect(() => injectSigs(proven, DKG_SIGHASH, sigs)).toThrow()
  })
})
