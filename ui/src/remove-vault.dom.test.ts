// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #813: removing a vault from this device removes everything the device keeps for it. It used to
// remove only the record in IndexedDB: the payee book, the passkey wrap and the recent addresses
// stayed in localStorage, and the two screens that remove a vault each cleared their own list of
// leftovers, which had already drifted apart (Vaults cleared the read secret and the wrap, Settings
// did not). Kept on purpose: the signed record, the device's memory of what it signed, which holds
// hashes and expiries only.
vi.setConfig({ testTimeout: 30_000 })

import { saveVault, listVaults, type VaultData } from './storage'
import { removeVaultFromDevice, clearVaultTraces } from './remove-vault'
import { setSelectedVault, getSelectedVault } from './api'
import { setReadSecret, readSecretFor } from './session'
import { savePrfWrap } from './prf-store'
import { pushRecentPayee, recentPayees } from './recent-payees'

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const data = (name: string, gk: number): VaultData => ({
  name, governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey: new Uint8Array(32).fill(gk), address: `u1${name}`, roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1),
})

function seedLocal(id: string) {
  localStorage.setItem(`konclave.benef.${id}`, JSON.stringify([{ id: 'p1', name: 'Bob', address: 'u1bob', memo: '', is_public: false }]))
  savePrfWrap(id, { credentialId: 'cred', salt: 'salt', iv: 'iv', ct: 'ct' } as never)
  localStorage.setItem(`konclave.folha.rascunho.${id}`, '{"lines":[]}')
  localStorage.setItem(`konclave.signed.${id}`, '[]')
  setSelectedVault(id)
  pushRecentPayee(`u1recent${id.slice(0, 4)}`)
  setReadSecret(id, new Uint8Array(32).fill(9))
  localStorage.setItem(`konclave.status.${id}`, JSON.stringify({ openCount: 0, proposalsAt: 1 }))
}
const keysWith = (id: string) => Object.keys(localStorage).filter((k) => k.includes(id))

describe('removing a vault takes everything this device keeps for it (#813)', () => {
  beforeEach(() => localStorage.clear())

  it('leaves no key of the vault but its signed record, and does not touch another vault', async () => {
    await saveVault(A, data('a', 0xaa), 'passphrase one two')
    await saveVault(B, data('b', 0xbb), 'passphrase one two')
    seedLocal(B)
    seedLocal(A) // A is the selected vault
    expect(await removeVaultFromDevice(A)).toBe(true)

    expect((await listVaults()).map((v) => v.id)).toEqual([B])
    expect(keysWith(A)).toEqual([`konclave.signed.${A}`])
    expect(getSelectedVault()).toBeNull()
    expect(readSecretFor(A)).toBeUndefined()

    // The other vault keeps all of its own.
    expect(keysWith(B).sort()).toEqual([
      `konclave.benef.${B}`, `konclave.folha.rascunho.${B}`, `konclave.prf.${B}`, `konclave.recentPayees.${B}`, `konclave.signed.${B}`, `konclave.status.${B}`,
    ].sort())
    expect(readSecretFor(B)).toBeDefined()
  })

  it('the recent addresses belong to a vault: one vault never offers another vault\'s payees', () => {
    setSelectedVault(A)
    pushRecentPayee('u1fora')
    setSelectedVault(B)
    expect(recentPayees()).toEqual([])
    pushRecentPayee('u1forb')
    expect(recentPayees()).toEqual(['u1forb'])
    setSelectedVault(A)
    expect(recentPayees()).toEqual(['u1fora'])
  })

  it('drops the unkeyed recent list of earlier versions, whose vault cannot be known', () => {
    localStorage.setItem('konclave.recentPayees', JSON.stringify(['u1legacy']))
    setSelectedVault(A)
    expect(recentPayees()).toEqual([])
    expect(localStorage.getItem('konclave.recentPayees')).toBeNull()
  })

  it('both screens that remove a vault call the one function, and no screen deletes a record on its own', async () => {
    for (const f of ['screens/Settings.tsx', 'screens/Vaults.tsx']) expect(codeOf(f), f).toMatch(/removeVaultFromDevice\(/)
    const { readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(process.cwd(), 'src', 'screens') // vitest runs from ui/
    const screens = readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !/\.test\./.test(n))
    const callers = screens.filter((n) => /\bforgetVault\(/.test(codeOf(`screens/${n}`)))
    expect(callers).toEqual([])
  })

  it('every screen that removes a vault goes through it, including the list inside the create flow', async () => {
    // The vault list of the create flow (`/net`, and the same component embedded in Vaults) had its
    // own delete button, which called the store's `deleteVault` directly: the record went, and the
    // payee book, the passkey wrap, the recent addresses and the read secret stayed.
    expect(codeOf('screens/NetVault.tsx')).toMatch(/removeVaultFromDevice\(/)
    // Only `remove-vault.ts` may take the record out of the store: whoever imports `deleteVault` or
    // `forgetVault` from it can remove a vault and skip what goes with it.
    const { readdirSync, statSync } = await import('node:fs')
    const { join, relative, sep } = await import('node:path')
    const src = join(process.cwd(), 'src')
    const files: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n) && !/\.test\.|\.d\.ts$/.test(n)) files.push(relative(src, p).split(sep).join('/'))
      }
    }
    walk(src)
    const importers = files.filter((f) => {
      for (const m of codeOf(f).matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.?\/)+storage['"]/g)) {
        if (/\b(?:deleteVault|forgetVault)\b/.test(m[1] ?? '')) return true
      }
      return false
    })
    expect(importers).toEqual(['remove-vault.ts'])
  })

  it('the confirm says what goes and what stays, and no longer promises to remove proposals', () => {
    // Proposals live on the vault's server, not on this device: removing a vault never touched them.
    expect(en['dashboard.deleteConfirmBody']).not.toMatch(/proposals/i)
    expect(ptBR['dashboard.deleteConfirmBody']).not.toMatch(/propostas/i)
    expect(en['dashboard.deleteConfirmBody']).toMatch(/saved people/)
    expect(en['dashboard.deleteConfirmBody']).toMatch(/keeps/)
    expect(ptBR['dashboard.deleteConfirmBody']).toMatch(/pessoas salvas/)
    expect(ptBR['dashboard.deleteConfirmBody']).toMatch(/Fica/)
  })

  it('on the local bridge, where the orchestrator deletes the record, the browser clears the same as on the web', () => {
    // It cleared only the payroll draft, while the confirm promised the recent addresses too.
    seedLocal(B)
    seedLocal(A)
    clearVaultTraces(A)
    expect(keysWith(A)).toEqual([`konclave.signed.${A}`])
    expect(getSelectedVault()).toBeNull()
    expect(readSecretFor(A)).toBeUndefined()
    expect(keysWith(B)).toHaveLength(6)
    const settings = codeOf('screens/Settings.tsx')
    expect(settings).toMatch(/res\.ok\) \{ clearVaultTraces\(vault\.id\)/)
    // No screen clears a part of a vault's leftovers on its own: that is how the two lists drifted.
    for (const part of ['clearPayrollDraft', 'clearRecentPayees']) expect(settings, part).not.toMatch(new RegExp(`\\b${part}\\(`))
  })
})

// Every place the app writes to this browser's storage, and what removing a vault does with it.
// A new write fails the test below until it is listed here. A key that belongs to one vault is
// cleared in `clearVaultTraces` (remove-vault.ts) and gets a line in `seedLocal` above, so the first
// test proves it goes; or it is kept on purpose, with the reason.
type Fate = 'device' | 'cleared' | 'kept'
const STORAGE_WRITES: Record<string, Record<string, Fate>> = {
  'api.ts': { VAULT_KEY: 'cleared' /* the selection, when it is this vault */, k: 'cleared' /* the payee book */ },
  'helper.ts': { MODE_KEY: 'device', URL_KEY: 'device' },
  'i18n/index.tsx': { LOCALE_KEY: 'device' },
  'net.ts': { RELAY_MODE_KEY: 'device', RELAY_URL_KEY: 'device' },
  'prf-store.ts': { 'KEY(vaultId)': 'cleared' },
  'price.ts': { KEY_ENABLED: 'device', KEY_CACHE: 'device' },
  'recent-payees.ts': { 'recentPayeesKey(id)': 'cleared' },
  'screens/NewPayroll.tsx': { draftAt: 'cleared' /* the payroll draft */ },
  'signed-record.ts': { k: 'kept' /* what this device signed: hashes and expiries, refuses a second tx */ },
  'storage.ts': { 'beneficiariesKey(id)': 'cleared' },
  'theme.ts': { KEY: 'device' },
  'vault-status.ts': { 'key(vault)': 'cleared' /* what the vault list last showed for this vault */ },
}

describe('every storage key the app writes has a stated fate when a vault is removed (#813)', () => {
  it('lists each write to localStorage or sessionStorage, and no other IndexedDB store', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const { join, relative, sep } = await import('node:path')
    const src = join(process.cwd(), 'src') // vitest runs from ui/
    const files: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(n) && !/\.test\.|\.d\.ts$/.test(n)) files.push(relative(src, p).split(sep).join('/'))
      }
    }
    walk(src)
    const found: Record<string, Record<string, Fate>> = {}
    for (const f of files) {
      const code = codeOf(f)
      for (const m of code.matchAll(/(?:localStorage|sessionStorage)\.setItem\(\s*([^,]+?)\s*,/g)) {
        const key = m[1] ?? ''
        found[f] ??= {}
        found[f][key] = STORAGE_WRITES[f]?.[key] ?? ('UNLISTED: say whether it belongs to a vault' as Fate)
      }
    }
    expect(found).toEqual(STORAGE_WRITES)
    // The record store is the one the removal deletes from. A second store would need its own line.
    expect(codeOf('storage.ts').match(/createObjectStore\(/g)).toHaveLength(1)
  })
})
