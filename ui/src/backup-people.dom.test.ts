// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The backup builder reports a backup made without the saved people, apart from "no viewing key".
vi.hoisted(() => { vi.stubEnv('VITE_HELPER_BASE', 'https://helper.test') })
vi.setConfig({ testTimeout: 60_000 })
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => undefined }))
const keys = vi.hoisted(() => ({ value: { ufvk: 'uview1x', birthday: 5 } as { ufvk: string; birthday: number } | null }))
vi.mock('./vault-receivers', async (orig) => ({ ...(await orig<typeof import('./vault-receivers')>()), checkedViewingKey: async () => keys.value }))

import { saveVault, deleteVault } from './storage'
import { buildVaultBackup } from './build-backup'

// This suite is about what a protected vault keeps on the device, with a stand-in share. The share
// check (#965) has its own real-wasm tests in share-import-check.test.ts, so here it is let through.
vi.mock('./share-check', () => ({ assertShareIsThisSeats: async () => {} }))

const GK = 'c3'.repeat(32)
const PASS = 'a long passphrase for tests'

beforeEach(async () => { keys.value = { ufvk: 'uview1x', birthday: 5 }; localStorage.clear(); await deleteVault(GK).catch(() => undefined) })

describe('buildVaultBackup', () => {
  const vault = () => saveVault(GK, {
    name: 'v', governance: 'quorum', myName: 'Alice', creatorName: 'Alice', groupKey: new Uint8Array(32).fill(0xc3),
    address: 'u1vault', roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1), accessSecret: new Uint8Array(32).fill(0x5a),
  }, PASS)

  it('a healthy vault: complete, nothing left out', async () => {
    await vault()
    const b = await buildVaultBackup(GK, PASS, 'v')
    expect(b.complete).toBe(true)
    expect(b.peopleLeftOut).toBeUndefined()
  })

  it('a book set aside: the backup is made, marked incomplete, and says the people were left out', async () => {
    await vault()
    localStorage.setItem(`konclave.benef.${GK}`, JSON.stringify({ v: 1, iv: btoa('x'.repeat(12)), ct: btoa('y'.repeat(40)) }))
    const b = await buildVaultBackup(GK, PASS, 'v')
    expect(b.complete).toBe(false)
    expect(b.peopleLeftOut).toBe(true)
  })

  it('both causes are returned apart: people left out AND viewing key missing', async () => {
    await vault()
    keys.value = null
    localStorage.setItem(`konclave.benef.${GK}`, JSON.stringify({ v: 1, iv: btoa('x'.repeat(12)), ct: btoa('y'.repeat(40)) }))
    const b = await buildVaultBackup(GK, PASS, 'v')
    expect(b.complete).toBe(false)
    expect(b.peopleLeftOut).toBe(true)
    expect(b.keyMissing).toBe(true)
  })

  it('only the key missing: the people are not said to be left out', async () => {
    await vault()
    keys.value = null
    const b = await buildVaultBackup(GK, PASS, 'v')
    expect(b.keyMissing).toBe(true)
    expect(b.peopleLeftOut).toBeUndefined()
  })

  it('the screens show both notices when both apply, and the people sentence does not vouch for the vault', async () => {
    const { codeOf } = await import('./source-scan')
    const { en } = await import('./i18n/en')
    const { ptBR } = await import('./i18n/pt-BR')
    // One reader of the two causes, used by both screens (and it names each cause, plus the unnamed one).
    for (const f of ['screens/Settings.tsx', 'screens/Vaults.tsx']) expect(codeOf(f), f).toMatch(/incompleteNotices\(/)
    expect(codeOf('build-backup.ts')).toMatch(/peopleLeftOut[\s\S]*keyMissing/)
    expect(en['export.peopleLeftOut']).not.toMatch(/and the vault/i)
    expect(ptBR['export.peopleLeftOut']).not.toMatch(/e o cofre/i)
  })

  it('an incomplete backup with no named cause still gets the generic warning', async () => {
    const { incompleteNotices } = await import('./build-backup')
    expect(incompleteNotices({ complete: false })).toEqual(['vaults.resumeBackupIncomplete'])
    expect(incompleteNotices({ complete: true })).toEqual([])
    expect(incompleteNotices({ complete: false, peopleLeftOut: true, keyMissing: true })).toEqual(['export.peopleLeftOut', 'vaults.resumeBackupIncomplete'])
    expect(incompleteNotices({ complete: false, peopleLeftOut: true })).toEqual(['export.peopleLeftOut'])
  })
})
