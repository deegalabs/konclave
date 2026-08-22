import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import {
  saveVault, loadVault, listVaults, deleteVault, storageAvailable,
  exportVault, importVault, parseVaultExport, type VaultData,
} from './storage'

// Covers the on-device share persistence (Marco 5): the encrypted IndexedDB round-trip that
// `storage.ts` performs. fake-indexeddb provides IndexedDB; Node's WebCrypto provides
// AES-GCM/PBKDF2 (crypto.subtle). The point is that a saved share comes back only with the
// right passphrase, never in the clear.

const share = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1))
const groupKey = new Uint8Array(32).fill(7)
const data: VaultData = {
  name: 'Test vault', governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey, address: 'u1examplevaultaddress', roster: ['Alice', 'Bob', 'Carol'], sealedShare: share,
}

describe('storage - encrypted IndexedDB persistence', () => {
  it('is available in the test environment (IndexedDB + WebCrypto)', () => {
    expect(storageAvailable()).toBe(true)
  })

  it('round-trips: save then load with the right passphrase recovers the sealed share and metadata', async () => {
    await saveVault('v1', data, 'correct horse battery staple')
    const loaded = await loadVault('v1', 'correct horse battery staple')
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
    expect(Array.from(loaded.groupKey)).toEqual(Array.from(groupKey))
    expect(loaded.address).toBe('u1examplevaultaddress')
    expect(loaded.roster).toEqual(['Alice', 'Bob', 'Carol'])
    expect(loaded.createdAt).toBeGreaterThan(0)
  })

  it('rejects a wrong passphrase (AES-GCM authentication fails)', async () => {
    await saveVault('v2', data, 'right-passphrase')
    await expect(loadVault('v2', 'wrong-passphrase')).rejects.toThrow(/wrong passphrase|tampered/i)
  })

  it('listVaults exposes only public metadata - never the secret share', async () => {
    const list = await listVaults()
    const v = list.find((x) => x.id === 'v1')
    expect(v).toBeTruthy()
    expect(v).not.toHaveProperty('sealedShare')
    expect(Object.keys(v!).sort()).toEqual(['address', 'createdAt', 'creatorName', 'governance', 'groupKey', 'id', 'myName', 'name', 'roster'])
    expect(v!.name).toBe('Test vault')
    expect(v!.governance).toBe('quorum')
    expect(v!.myName).toBe('Alice')
    expect(v!.creatorName).toBe('Alice')
    // The 1..32 share bytes must not leak through the public metadata.
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(Array.from(share)))
  })

  it('lists and deletes a vault; a deleted vault cannot be loaded', async () => {
    await saveVault('v3', data, 'p')
    expect((await listVaults()).map((x) => x.id)).toContain('v3')
    await deleteVault('v3')
    expect((await listVaults()).map((x) => x.id)).not.toContain('v3')
    await expect(loadVault('v3', 'p')).rejects.toThrow(/no saved vault/i)
  })

  it('requires an id and a passphrase to save', async () => {
    await expect(saveVault('', data, 'p')).rejects.toThrow(/id is required/i)
    await expect(saveVault('x', data, '')).rejects.toThrow(/passphrase is required/i)
  })
})

describe('storage - portable vault export/import (#214)', () => {
  const pass = 'move-me-to-another-device'

  it('exports an encrypted bundle that never contains the plaintext share', async () => {
    await saveVault('exp1', data, pass)
    const bundle = await exportVault('exp1', pass)
    expect(bundle.format).toBe('konclave-vault-export')
    expect(bundle.version).toBe(1)
    expect(bundle.vault.id).toBe('exp1')
    expect(bundle.vault.groupKey).toBe('07'.repeat(32))
    // The 1..32 secret share bytes must never appear anywhere in the serialized bundle.
    const json = JSON.stringify(bundle)
    expect(json).not.toContain(JSON.stringify(Array.from(share)))
    expect(json).not.toContain(share.reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''))
  })

  it('export rejects a wrong passphrase', async () => {
    await saveVault('exp2', data, pass)
    await expect(exportVault('exp2', 'nope')).rejects.toThrow(/wrong passphrase|tampered/i)
  })

  it('round-trips across a fresh device: export -> delete -> import -> load recovers the share', async () => {
    await saveVault('exp3', data, pass)
    const bundle = await exportVault('exp3', pass)
    const roundtripped = parseVaultExport(JSON.stringify(bundle)) // survives file/paste serialization
    await deleteVault('exp3') // simulate a new device with no record
    expect((await listVaults()).map((x) => x.id)).not.toContain('exp3')

    const meta = await importVault(roundtripped, pass)
    expect(meta.id).toBe('exp3')
    expect(meta.name).toBe('Test vault')

    const loaded = await loadVault('exp3', pass)
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
    expect(Array.from(loaded.groupKey)).toEqual(Array.from(groupKey))
    expect(loaded.roster).toEqual(['Alice', 'Bob', 'Carol'])
  })

  it('import rejects a wrong passphrase before writing anything', async () => {
    await saveVault('exp4', data, pass)
    const bundle = await exportVault('exp4', pass)
    await deleteVault('exp4')
    await expect(importVault(bundle, 'wrong')).rejects.toThrow(/wrong passphrase/i)
    expect((await listVaults()).map((x) => x.id)).not.toContain('exp4')
  })

  it('import refuses to overwrite an existing vault unless overwrite is set', async () => {
    await saveVault('exp5', data, pass)
    const bundle = await exportVault('exp5', pass)
    await expect(importVault(bundle, pass)).rejects.toThrow(/already exists/i)
    // With overwrite it succeeds.
    const meta = await importVault(bundle, pass, { overwrite: true })
    expect(meta.id).toBe('exp5')
  })

  it('parseVaultExport rejects junk and foreign JSON', () => {
    expect(() => parseVaultExport('not json')).toThrow(/not valid JSON|not a Konclave/i)
    expect(() => parseVaultExport(JSON.stringify({ format: 'something-else' }))).toThrow(/not a Konclave/i)
    expect(() => parseVaultExport(JSON.stringify({ format: 'konclave-vault-export', version: 1 }))).toThrow(/incomplete|corrupt/i)
  })
})
