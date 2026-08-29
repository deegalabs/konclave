import { describe, it, expect } from 'vitest'
import { generateVaultSecret, VAULT_SECRET_BYTES } from './vault-secret'

// The per-vault access secret S (#388). A fresh 32 bytes of randomness, independent of any DKG
// material (which is public or relay-observable), so neither the relay nor an id-only outsider can
// derive it. The creator mints it once and seals it to the seated members.
describe('vault-secret - generate S (#388)', () => {
  it('is 32 bytes', () => {
    expect(generateVaultSecret().length).toBe(VAULT_SECRET_BYTES)
    expect(VAULT_SECRET_BYTES).toBe(32)
  })

  it('is fresh each time (not a constant)', () => {
    const a = generateVaultSecret()
    const b = generateVaultSecret()
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })
})
