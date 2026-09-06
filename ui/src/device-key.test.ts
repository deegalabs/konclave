import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import init, { sealTo } from './wasm-pkg/konclave_wasm.js'
import { deviceCommsKey, devicePubHex, deviceWriteKeyHex, signGovernanceWrite } from './device-key'
import { signWrite } from './wasm-pkg/konclave_wasm.js'

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

// #288 / ADR-0011 D1. The write identity: same share, own HKDF label, secret never in JS.
describe('the device write identity', () => {
  const shareA = enc('device A serialized FROST KeyPackage')
  const shareB = enc('device B serialized FROST KeyPackage')

  it('is deterministic and different from the comms key', () => {
    expect(deviceWriteKeyHex(shareA)).toBe(deviceWriteKeyHex(shareA))
    expect(deviceWriteKeyHex(shareA)).not.toBe(deviceWriteKeyHex(shareB))
    expect(deviceWriteKeyHex(shareA)).not.toBe(devicePubHex(shareA))
  })

  it('signs a write, and the proof is bound to the action, the target and the seat', () => {
    const a = signGovernanceWrite(shareA, 'vault-1', 'approve', 'prop-1', 1)
    expect(a.sig).toMatch(/^[0-9a-f]{128}$/)
    expect(a.seat).toBe(1)
    expect(a.nonce.length).toBeGreaterThan(8)

    // A different action, target or seat over the same everything else is a different signature.
    // The nonce and ts differ per call, so this compares the SIGNED MESSAGE via a fixed proof.
    const sameInputs = (action: 'approve' | 'refuse', target: string, seat: number) =>
      signWrite(shareA, 'vault-1', action, target, seat, 1_700_000_000_000, 'n')
    const base = sameInputs('approve', 'prop-1', 1)
    expect(sameInputs('refuse', 'prop-1', 1)).not.toBe(base)
    expect(sameInputs('approve', 'prop-2', 1)).not.toBe(base)
    expect(sameInputs('approve', 'prop-1', 2)).not.toBe(base)
    expect(sameInputs('approve', 'prop-1', 1)).toBe(base) // and it is deterministic
  })

  it('refuses an action the helper would not recognise, rather than signing it', () => {
    // Signing an unknown action would produce a proof nothing can verify, and the member would be
    // told their vote was refused with no way to tell why.
    expect(() => signWrite(shareA, 'v', 'delete-everything', 't', 1, 1, 'n')).toThrow()
  })
})
