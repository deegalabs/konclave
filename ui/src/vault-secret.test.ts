import { describe, it, expect } from 'vitest'
import { generateVaultSecret, VAULT_SECRET_BYTES, deriveReadKey } from './vault-secret'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

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

// The helper read token (#388 Passo 2): readKey = HKDF(S, "read"). Domain-separated from S so a
// leaked read token (a logged header) does not reveal S or the signing room. The client sends this
// once at registration; the helper stores it and compares it on every read.
describe('vault-secret - deriveReadKey (#388)', () => {
  const S = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1))

  it('is 32 bytes and deterministic for the same secret', async () => {
    const a = await deriveReadKey(S)
    const b = await deriveReadKey(S)
    expect(a.length).toBe(32)
    expect(hex(a)).toBe(hex(b))
  })

  it('differs for a different secret', async () => {
    const other = new Uint8Array(32).fill(9)
    expect(hex(await deriveReadKey(S))).not.toBe(hex(await deriveReadKey(other)))
  })

  it('is not the secret itself (domain separation)', async () => {
    expect(hex(await deriveReadKey(S))).not.toBe(hex(S))
  })
})
