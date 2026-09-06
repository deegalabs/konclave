import { describe, expect, it } from 'vitest'
import { asEnvelope, openEnvelope, type Opener } from './envelope'

// #481. The helper serves the viewing key SEALED once the vault has a registered device, so the
// browser's own extensions and any TLS-terminating proxy read ciphertext instead of the key that
// decrypts every payslip the vault ever sent.
//
// This drives the DEVICE half against a hand-built envelope, so it fails if either end changes the
// shape - which is the whole reason the format has one implementation per side rather than two.

const KIND = 'konclave-ufvk-sealed'
const PUB = 'ab'.repeat(32)

/** An opener that returns a fixed body key, standing in for the WASM device key. */
function opener(bodyKey: Uint8Array, expectAad: string): Opener {
  return {
    open: (sealed, aad) => {
      const aadHex = Array.from(aad, (b) => b.toString(16).padStart(2, '0')).join('')
      if (aadHex !== expectAad) throw new Error('wrong AAD')
      if (sealed.length === 0) throw new Error('empty box')
      return bodyKey
    },
  }
}

describe('the sealed viewing key', () => {
  it('is not an envelope when the helper sent the plaintext compat shape', () => {
    // A vault with no registered device still gets the plain object, and the caller must be able to
    // tell WITHOUT a throw - that fallback is what keeps an unmigrated vault working (#63's rule).
    expect(asEnvelope({ ufvk: 'uview1x', birthday: 1 }, KIND)).toBeNull()
    expect(asEnvelope(null, KIND)).toBeNull()
    expect(asEnvelope({ kind: 'something-else', body: 'aa', boxes: {} }, KIND)).toBeNull()
    expect(asEnvelope({ kind: KIND, body: 'aa' }, KIND), 'boxes is required').toBeNull()
  })

  it('recognises an envelope of the right kind', () => {
    const env = asEnvelope({ kind: KIND, body: 'aabb', boxes: { [PUB]: 'ccdd' } }, KIND)
    expect(env?.body).toBe('aabb')
  })

  it('returns null when there is no box for this device, rather than throwing', () => {
    // A device that is registered on the vault but not named in THIS envelope must degrade to "I
    // cannot read it", never to an exception the caller has to remember to catch.
    const env = asEnvelope({ kind: KIND, body: 'aabb', boxes: { ['cd'.repeat(32)]: 'ee' } }, KIND)!
    expect(openEnvelope(env, opener(new Uint8Array(32), PUB), PUB)).toBeNull()
  })

  it('returns null when the box does not open, rather than throwing', () => {
    const env = asEnvelope({ kind: KIND, body: 'aabb', boxes: { [PUB]: '' } }, KIND)!
    expect(openEnvelope(env, opener(new Uint8Array(32), PUB), PUB)).toBeNull()
  })

  it('passes the device pubkey as the AAD, which is what pins a box to its slot', () => {
    // Without this the box is a portable ciphertext and anyone who can write the envelope could
    // move one device's box into another's slot.
    const env = asEnvelope({ kind: KIND, body: 'aabb', boxes: { [PUB]: 'ff' } }, KIND)!
    expect(openEnvelope(env, opener(new Uint8Array(32), 'cd'.repeat(32)), PUB)).toBeNull()
  })
})
