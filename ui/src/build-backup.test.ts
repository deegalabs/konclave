import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
// #669: this file derives keys (PBKDF2 at 600k rounds, AES-GCM) in most of its tests. Measured on
// an idle machine the slowest took 2.5 s, so under load they cross the 5 s default and read as a
// regression. The limit is raised for this file only; the global one in vite.config.ts stays.
vi.setConfig({ testTimeout: 30_000 })

import { readdirSync } from 'node:fs'
import { codeOf } from './source-scan'

// The backup has one builder; the creation's end, Settings and the vault card all use it.
const h = vi.hoisted(() => ({
  getUfvk: vi.fn(async () => ({ ufvk: 'uview1x', birthday: 3_000_000 }) as { ufvk?: string; birthday?: number } | null),
  exportVault: vi.fn(async () => ({ v: 2, blob: 'opaque' })),
  loadVault: vi.fn(async () => ({})),
  list: vi.fn(async () => [] as unknown[]),
  checkedWith: [] as unknown[],
}))
// A share in session that lacks the scan floor: the backup must not read it (F1).
vi.mock('./session', async (orig) => ({ ...(await orig<typeof import('./session')>()), getUnlockedShare: () => ({ fromSession: true }) }))
vi.mock('./vault-receivers', async (orig) => {
  const real = await orig<typeof import('./vault-receivers')>()
  return { ...real, checkedViewingKey: (id: string, rec: unknown) => { h.checkedWith.push(rec); return real.checkedViewingKey(id, rec as never) } }
})
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./signing', () => ({ decodeBundle: () => ({ keyPackage: new Uint8Array(4) }) }))
vi.mock('./device-key', () => ({ deviceCommsKey: () => new Uint8Array(32), devicePubHex: () => 'pub' }))
vi.mock('./helper', () => ({ getUfvk: h.getUfvk }))
// The name is the real `backupFileName` (storage.ts): only the export itself is mocked.
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), exportVault: h.exportVault, loadVault: h.loadVault, listVaults: h.list }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ vaultReceivers: () => { throw new Error('NotThisVault') }, uaIsExactly: () => true }))

const { buildVaultBackup } = await import('./build-backup')

describe('buildVaultBackup', () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 16, 13, 5)) })
  afterAll(() => { vi.useRealTimers() })
  it('builds the export with the viewing key and the scan floor, under a neutral name with the time (#587)', async () => {
    const b = await buildVaultBackup('v1', 'pass', 'Team Fund!')
    expect(h.exportVault).toHaveBeenCalledWith('v1', 'pass', 'uview1x', 3_000_000)
    expect(b.name).toBe('konclave-backup-2026-10-16-1305.konclave.json') // nothing of the vault in the name (#587)
    expect(JSON.parse(b.json)).toEqual({ v: 2, blob: 'opaque' })
    expect(b.complete).toBe(true)
  })
  it('is incomplete when the key came without the scan floor: a wallet rebuilt without it starts at now', async () => {
    h.getUfvk.mockResolvedValueOnce({ ufvk: 'uview1x', birthday: undefined })
    expect((await buildVaultBackup('v1', 'pass', 'v')).complete).toBe(false)
    h.getUfvk.mockResolvedValueOnce({ birthday: 3_000_000 })
    expect((await buildVaultBackup('v1', 'pass', 'v')).complete).toBe(false)
    h.getUfvk.mockResolvedValueOnce({ ufvk: 'uview1x', birthday: 0 })
    expect((await buildVaultBackup('v1', 'pass', 'v')).complete).toBe(true) // 0 is a height
  })
  it('reads the record under the passphrase, never a session copy that lacks its scan floor', async () => {
    h.loadVault.mockClear()
    h.loadVault.mockResolvedValueOnce({ fromRecord: true })
    h.checkedWith.length = 0
    await buildVaultBackup('v1', 'pass', 'v')
    expect(h.loadVault).toHaveBeenCalledWith('v1', 'pass')
    expect(h.checkedWith).toEqual([{ fromRecord: true }])
  })
  it('with no share in session the passphrase opens one, and a key that does not derive the record stays out', async () => {
    h.list.mockResolvedValue([{ id: 'v3', cp: 3, address: 'a', changeReceiver: 'c' }])
    h.exportVault.mockClear()
    const b = await buildVaultBackup('v3', 'pass', 'v')
    expect(h.loadVault).toHaveBeenCalledWith('v3', 'pass')
    expect(h.exportVault).toHaveBeenCalledWith('v3', 'pass', undefined, undefined, { storedKey: false })
    expect(b.complete).toBe(false)
    h.list.mockResolvedValue([])
  })
  it('says incomplete when the coordinator would not give the key, and still builds', async () => {
    h.getUfvk.mockResolvedValueOnce(null)
    const b = await buildVaultBackup('v1', 'pass', undefined)
    expect(b.complete).toBe(false)
    expect(b.name).toBe('konclave-backup-2026-10-16-1305.konclave.json')
  })
})

describe('the pin: exportVault is built in one place', () => {
  it('only build-backup.ts calls exportVault; the three screens call the builder', () => {
    const callers: string[] = []
    const walk = (sub: string) => {
      for (const e of readdirSync(new URL(sub, new URL('./', import.meta.url)), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          if (/\bexportVault\(/.test(codeOf(`./${sub}${e.name}`).replace(/export async function exportVault\(/, ''))) callers.push(`${sub}${e.name}`)
        }
      }
    }
    walk('')
    expect(callers).toEqual(['build-backup.ts'])
    for (const f of ['./screens/NetVault.tsx', './screens/Settings.tsx', './screens/Vaults.tsx']) {
      expect(codeOf(f), f).toMatch(/buildVaultBackup\(/)
    }
  })
})
