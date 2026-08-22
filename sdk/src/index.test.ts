import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, it, expect, beforeAll } from 'vitest'
import {
  init,
  localTestCeremony,
  participantRound2WithRandomizer,
  pcztSighash,
  extractRandomizers,
  describeOutputs,
  injectSigs,
  toHex,
  fromHex,
  toBase64,
  fromBase64,
  bytesEqual,
} from './index.js'

// Load the real compiled wasm core once (the same artifact the browser loads), reading the
// bytes under Node exactly as the README's Node recipe does.
beforeAll(async () => {
  const require = createRequire(import.meta.url)
  const wasmPath = require.resolve('konclave-wasm/konclave_wasm_bg.wasm')
  await init(readFileSync(wasmPath))
})

describe('@konclave/frost smoke test', () => {
  it('runs a full local 2-of-3 ceremony and verifies the signature', () => {
    const { signature, verified, ms } = localTestCeremony()
    expect(verified).toBe(true)
    expect(signature).toBeInstanceOf(Uint8Array)
    expect(signature.length).toBe(64)
    expect(ms).toBeGreaterThanOrEqual(0)
  })

  it('signs a custom message and still verifies', () => {
    const res = localTestCeremony(new TextEncoder().encode('a different message'))
    expect(res.verified).toBe(true)
  })

  it('exports the rerandomized / PCZT Orchard signing surface', () => {
    // These are the symbols a wallet needs to sign a real Orchard spend (mirrors
    // ui/src/signing-machine.ts). We assert they are wired through, not exercise them
    // (that needs a proven PCZT the wallet builds).
    expect(typeof participantRound2WithRandomizer).toBe('function')
    expect(typeof pcztSighash).toBe('function')
    expect(typeof extractRandomizers).toBe('function')
    expect(typeof describeOutputs).toBe('function')
    expect(typeof injectSigs).toBe('function')
  })
})

describe('byte helpers', () => {
  it('round-trips hex and base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    expect(fromHex(toHex(bytes))).toEqual(bytes)
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })

  it('bytesEqual is true only for identical arrays', () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})
