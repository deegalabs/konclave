import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import init, { sealTo } from './wasm-pkg/konclave_wasm.js'
import { deviceCommsKey, devicePubHex } from './device-key'
import { SEALED_REQUEST_KIND, unsealSignRequest } from './net-sign'
import { bytesToHex, hexToBytes } from './bytes'

const share = new TextEncoder().encode('this device KeyPackage')
let pubHex = ''

beforeAll(async () => {
  const wasm = readFileSync(fileURLToPath(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
  await init(wasm)
  pubHex = devicePubHex(share) // needs the wasm, so derive it after init
})

const enc = (s: string) => new TextEncoder().encode(s)

// Build the SAME sealed wire the Rust helper posts: one box per device pubkey, the box being
// hex(seal(pub, plaintext, aad = pub)).
function sealWireFor(pubHexes: string[], plaintext: string): string {
  const boxes: Record<string, string> = {}
  for (const ph of pubHexes) {
    const pub = hexToBytes(ph)
    boxes[ph] = bytesToHex(sealTo(pub, enc(plaintext), pub))
  }
  return JSON.stringify({ kind: SEALED_REQUEST_KIND, boxes })
}

describe('unsealSignRequest (#63) — the device opens its box', () => {
  const request = JSON.stringify({ kind: 'net-sign-request', sighash: 'abcd', spends: [], pczt_hex: 'dead' })

  it('recovers the exact request from a box sealed to this device', () => {
    const wire = sealWireFor([pubHex, 'bb'.repeat(32)], request)
    expect(unsealSignRequest(wire, deviceCommsKey(share), pubHex)).toBe(request)
  })

  it('passes a plaintext request straight through (compat)', () => {
    expect(unsealSignRequest(request, deviceCommsKey(share), pubHex)).toBe(request)
  })

  it('leaves a sealed message that has no box for this device untouched', () => {
    const wire = sealWireFor(['bb'.repeat(32)], request) // sealed only to some OTHER device
    expect(unsealSignRequest(wire, deviceCommsKey(share), pubHex)).toBe(wire)
  })
})
