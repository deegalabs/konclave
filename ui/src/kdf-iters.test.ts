import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { openExport, kdfIterationsOf } from '../../scripts/open-export.mjs'
import { importVault, loadVault, kdfItersOf, type VaultExport } from './storage'

// The PBKDF2 count travels with the ciphertext (#443), so a backup names its own. Every reader takes
// it through one rule: absent means the legacy count, otherwise a whole number between the legacy
// count and a ceiling, and anything else is refused before any derivation.

const HUGE = 2 ** 31
const hex = (n: number) => 'ab'.repeat(n)
const v2 = (kdfIters: unknown) => ({ format: 'konclave-vault-export', version: 2, exportedAt: 1, salt: hex(16), iv: hex(12), cipher: hex(48), kdfIters })
const v1 = (kdfIters: unknown) => ({
  format: 'konclave-vault-export', version: 1, exportedAt: 1,
  vault: { id: 'cd'.repeat(32), name: 'F', groupKey: 'cd'.repeat(32), roster: ['A'], createdAt: 1, salt: hex(16), iv: hex(12), cipher: hex(48), kdfIters },
})

afterEach(() => vi.restoreAllMocks())

describe('the count a sealed record or a backup may name', () => {
  const accepted: [unknown, number][] = [[undefined, 210_000], [null, 210_000], [210_000, 210_000], [310_000, 310_000], [600_000, 600_000], [700_000, 700_000], [5_000_000, 5_000_000]]
  const refused: unknown[] = [HUGE, 5_000_001, 209_999, 0, -1, 600_000.5, '600000', NaN, Infinity, true, {}]

  it('accepts the legacy count when absent, and whole numbers up to the ceiling', () => {
    for (const [v, n] of accepted) expect(kdfItersOf(v), String(v)).toBe(n)
  })

  it('refuses anything else', () => {
    for (const v of refused) expect(() => kdfItersOf(v), String(v)).toThrow()
  })

  it('the recovery script reads the field by the same rule as the app', () => {
    for (const [v, n] of accepted) expect(kdfIterationsOf(v), String(v)).toBe(n)
    for (const v of refused) expect(() => kdfIterationsOf(v), String(v)).toThrow()
  })
})

describe('a backup naming a count past the ceiling is refused before any derivation', () => {
  it('importing a v2 or a v1 backup', async () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveKey')
    for (const bundle of [v2(HUGE), v1(HUGE)]) {
      await expect(importVault(bundle as unknown as VaultExport, 'pass phrase here')).rejects.toMatchObject({ code: 'corrupt' })
    }
    expect(derive).not.toHaveBeenCalled()
  })

  it('opening it with the recovery script', async () => {
    const derive = vi.spyOn(globalThis.crypto.subtle, 'deriveKey')
    for (const bundle of [v2(HUGE), v1(HUGE)]) {
      await expect(openExport(bundle, 'pass phrase here')).rejects.toThrow(/key-derivation count/)
    }
    expect(derive).not.toHaveBeenCalled()
  })

  it('opening a saved record whose stored count was changed', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('konclave', 1)
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('vaults')) req.result.createObjectStore('vaults', { keyPath: 'id' }) }
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const tx = req.result.transaction('vaults', 'readwrite')
        tx.objectStore('vaults').put({
          id: 'kdf-huge', name: 'Huge', groupKey: 'ef'.repeat(32), address: 'u1x', roster: ['A'], createdAt: 1,
          salt: new Uint8Array(16), iv: new Uint8Array(12), cipher: new Uint8Array(48), kdfIters: HUGE,
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
    })
    const derive = vi.spyOn(crypto.subtle, 'deriveKey')
    await expect(loadVault('kdf-huge', 'pass phrase here')).rejects.toMatchObject({ code: 'corrupt' })
    expect(derive).not.toHaveBeenCalled()
  })
})
