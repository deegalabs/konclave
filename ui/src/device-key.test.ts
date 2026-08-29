import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import init, { sealTo } from './wasm-pkg/konclave_wasm.js'
import { deviceCommsKey, devicePubHex } from './device-key'

// Load the real wasm artifact the browser loads (same pattern as wasm-bridge.test.ts).
beforeAll(async () => {
  const wasm = readFileSync(fileURLToPath(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
  await init(wasm)
})

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe('device comms identity (#63) — the browser binding', () => {
  const shareA = enc('device A serialized FROST KeyPackage')
  const shareB = enc('device B serialized FROST KeyPackage')

  it('derives a STABLE identity from the share (reproduced on every unlock)', () => {
    expect(devicePubHex(shareA)).toBe(devicePubHex(shareA))
  })

  // THE RULE: every device/seat must get its OWN identity, or the helper cannot address a sealed
  // request to a specific device and authentication is meaningless. A stub that ignores the share
  // fails exactly here.
  it('derives a DISTINCT identity for a different share', () => {
    expect(devicePubHex(shareA)).not.toBe(devicePubHex(shareB))
  })

  it('opens exactly what the helper would seal to its registered public', () => {
    const pub = deviceCommsKey(shareA).publicBytes()
    const aad = enc('helper->device:sign-request')
    const sealed = sealTo(pub, enc('sighash+alpha+pczt'), aad)
    expect(dec(deviceCommsKey(shareA).open(sealed, aad))).toBe('sighash+alpha+pczt')
  })
})
