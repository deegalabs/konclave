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
import { removeVaultFromDevice } from './remove-vault'
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
      `konclave.benef.${B}`, `konclave.folha.rascunho.${B}`, `konclave.prf.${B}`, `konclave.recentPayees.${B}`, `konclave.signed.${B}`,
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
    const callers = screens.filter((n) => /forgetVault\(/.test(codeOf(`screens/${n}`)))
    expect(callers).toEqual([])
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
})
