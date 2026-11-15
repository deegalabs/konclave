import { describe, expect, it } from 'vitest'
import { usernameName, vaultTag, vaultUsername } from './vault-username'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('the tag a password manager sees (#929)', () => {
  it('is 4 hex characters and matches a known vector', async () => {
    // Computed outside the code: sha256("konclave-manager-tag-v1 " + id)[0:4 hex].
    expect(await vaultTag(A)).toBe('62e6')
    expect(await vaultTag(B)).toBe('7596')
  })

  it('is not the id prefix and not the first hex of the id\'s plain hash (the fingerprint source)', async () => {
    expect(await vaultTag(A)).not.toBe(A.slice(0, 4))
    expect(await vaultTag(A)).not.toBe('ffe0') // sha256(A)[0:4]
    expect(await vaultTag(B)).not.toBe('a0fa')
  })

  it('is the same for the same id however it is written, and differs between vaults', async () => {
    expect(await vaultTag(` ${A.toUpperCase()} `)).toBe(await vaultTag(A))
    expect(await vaultTag(A)).not.toBe(await vaultTag(B))
  })

  it('moves when the salt moves (the id alone is not the input)', async () => {
    const plain = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(A)))
    expect(Array.from(plain.slice(0, 2), (b) => b.toString(16).padStart(2, '0')).join('')).not.toBe(await vaultTag(A))
  })
})

describe('the username (#929)', () => {
  it('is the record\'s name, normalised, and the tag', async () => {
    expect(await vaultUsername('Treasury', A)).toBe('Treasury · 62e6')
    expect(await vaultUsername('  Treasury ', A)).toBe('Treasury · 62e6')
    // NFC: the same accent typed two ways is one name.
    expect(await vaultUsername('Café', A)).toBe(await vaultUsername('Café', A))
  })

  it('uses a fixed, untranslated literal for a vault with no name', async () => {
    for (const raw of [undefined, null, '', '   ']) expect(await vaultUsername(raw, A)).toBe('Konclave · 62e6')
    expect(usernameName(undefined)).toBe('Konclave')
  })

  it('is equal when the create screen and the unlock screen build it from the same record', async () => {
    const stored = 'Common Treasury'
    expect(await vaultUsername(stored, A)).toBe(await vaultUsername(stored, A.toUpperCase()))
  })

  it('is null, not name-only, where WebCrypto is unavailable', async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    try {
      expect(await vaultUsername('Treasury', A)).toBeNull()
    } finally {
      Object.defineProperty(globalThis, 'crypto', real)
    }
  })
})
