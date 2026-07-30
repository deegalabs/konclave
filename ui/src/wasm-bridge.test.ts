/// <reference types="node" />
// End-to-end test of the FROST<->PCZT bridge across the JS boundary (slice 2). This exercises the
// real wasm-pack artifact the browser loads — describeOutputs / extractRandomizers / injectSigs —
// against the same real Ironwood (V6/NU6.3, pczt v2) golden vector that pins the native signer
// (audit C6). It proves the wire encoding round-trips in JavaScript, not just that Rust compiles.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import init, { describeOutputs, extractRandomizers, injectSigs } from './wasm-pkg/konclave_wasm.js'

const vec = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../konclave-wasm/tests/vectors/${name}`, import.meta.url)))

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// Ironwood single_spend vector: the shielded sighash the aggregate signature commits to, plus the
// action-0 alpha. A `create-max` tx spending four notes, so every action is a real Ironwood spend.
const IW_SIGHASH = hex('332de126200c22131337474ae50367218ec87815c23d297dcdc8278ecb8903b0')
const IW_ALPHA0 = '63267dad44b3621cd5246056295def55bd012cb053de4ba7af406e35d4ba4734'

beforeAll(async () => {
  const wasmBytes = readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url))
  await init(wasmBytes)
})

describe('FROST<->PCZT bridge over the JS boundary (Ironwood v2)', () => {
  const proven = vec('ironwood_single_spend.proven.pczt')
  const signed = vec('ironwood_single_spend.signed.pczt')
  const sig0 = vec('ironwood_single_spend.sig0.raw')

  it('describeOutputs reads the Ironwood outputs the human must confirm', () => {
    const outs = JSON.parse(describeOutputs(proven)) as { address: string | null; value: number | null }[]
    expect(outs.length).toBeGreaterThan(0)
    expect(outs.some((o) => o.value !== null)).toBe(true)
  })

  it('extractRandomizers yields every real Ironwood spend index and alpha', () => {
    const buf = extractRandomizers(proven)
    expect(buf.length).toBe(4 * 36) // four 36-byte records: u32 index + 32-byte alpha
    const index0 = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true)
    expect(index0).toBe(0) // first real Ironwood spend at action index 0
    expect(toHex(buf.slice(4, 36))).toBe(IW_ALPHA0)
  })

  it('injectSigs reproduces the exact signed v2 PCZT the canonical signer produces', () => {
    // one 68-byte signature record: u32-LE index 0, then the 64-byte aggregate signature
    const sigs = new Uint8Array(68)
    new DataView(sigs.buffer).setUint32(0, 0, true)
    sigs.set(sig0, 4)
    const out = injectSigs(proven, IW_SIGHASH, sigs)
    expect(toHex(out)).toBe(toHex(signed))
  })

  it('injectSigs rejects a signature that does not verify', () => {
    const sigs = new Uint8Array(68)
    new DataView(sigs.buffer).setUint32(0, 0, true) // index 0, sig left as zeros
    expect(() => injectSigs(proven, IW_SIGHASH, sigs)).toThrow()
  })
})
