import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { saveVault, exportVault, importVault, parseVaultExport, deleteVault, type VaultData } from './storage'
import { StorageError, storageErrorKey } from './storage-errors'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { codeOf } from './source-scan'

// #586: the import and export dialogs showed `e.message` from storage.ts, English literals, on the
// screen of a member restoring the one copy of their seat. The storage layer now refuses with a
// code; one mapping turns it into a dictionary key; the dialogs translate it.
const GK7 = '07'.repeat(32)
const data: VaultData = {
  name: 'Test vault', governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey: new Uint8Array(32).fill(7), address: 'u1examplevaultaddress', roster: ['Alice', 'Bob', 'Carol'],
  sealedShare: new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)),
}
const pass = 'correct horse'

const keyOf = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return storageErrorKey(e, 'import.errGeneric') }
  throw new Error('expected a refusal')
}

describe('storage refusals reach the member in their language (#586)', () => {
  it('a wrong passphrase on import is Portuguese in pt-BR, and says nothing was imported', async () => {
    await saveVault(GK7, data, pass)
    const bundle = await exportVault(GK7, pass)
    await deleteVault(GK7)
    const key = await keyOf(importVault(bundle, 'wrong'))
    expect(key).toBe('storage.err.wrongPassphrase')
    expect(ptBR[key]).toMatch(/Frase-senha errada/)
    expect(ptBR[key]).not.toMatch(/Wrong passphrase/)
    expect(en[key]).toMatch(/Wrong passphrase/)
  })

  it('a vault already on the device is Portuguese in pt-BR', async () => {
    await saveVault(GK7, data, pass)
    const bundle = await exportVault(GK7, pass)
    const key = await keyOf(importVault(bundle, pass))
    expect(key).toBe('storage.err.alreadyExists')
    expect(ptBR[key]).toMatch(/Este cofre já está neste aparelho/)
    await deleteVault(GK7)
  })

  it('a corrupt export and a file that is no export have their own sentences', async () => {
    expect(await keyOf(Promise.reject(tryParse('not json at all')))).toBe('storage.err.notAnExport')
    expect(await keyOf(Promise.reject(tryParse(JSON.stringify({ format: 'konclave-vault-export', version: 2 }))))).toBe('storage.err.corrupt')
  })

  it('every code has a key in both dictionaries, and an error without a code falls back', () => {
    const codes = ['no-storage', 'no-vault', 'no-id', 'passphrase-required', 'new-passphrase-required', 'wrong-passphrase', 'wrong-passphrase-saved',
      'not-an-export', 'corrupt', 'unsupported-version', 'already-exists', 'same-passphrase'] as const
    for (const c of codes) {
      const k = storageErrorKey(new StorageError(c, 'x'), 'fallback')
      expect(k, c).toMatch(/^storage\.err\./)
      expect(en[k], k).toBeTruthy()
      expect(ptBR[k], k).toBeTruthy()
    }
    expect(storageErrorKey(new Error('plain'), 'import.errGeneric')).toBe('import.errGeneric')
    expect(storageErrorKey('a string', 'export.errGeneric')).toBe('export.errGeneric')
  })

  it('the rotate dialog tells "same passphrase" apart by its code, not by its English text', () => {
    const src = codeOf('./screens/Settings.tsx')
    expect(src).not.toMatch(/includes\('same as'\)/)
    expect(src).toMatch(/e instanceof StorageError && e\.code === 'same-passphrase'/)
  })

  it('the help text quotes the sentences the member now sees, in each language', () => {
    const docs = codeOf('./docs/content.ts')
    expect(docs).not.toMatch(/aparece em inglês|também em inglês/)
    expect(docs).toContain('Frase-senha errada para este backup')
    expect(docs).toContain('Wrong passphrase for this backup')
  })

  it('the storage layer keeps no UI strings, and both dialogs translate through the one mapping', () => {
    const storage = codeOf('./storage.ts')
    expect(storage).not.toMatch(/throw new Error\(/) // every refusal carries a code
    expect(storage).not.toMatch(/from '\.\/i18n/)
    for (const f of ['./screens/Settings.tsx', './screens/Vaults.tsx']) {
      const src = codeOf(f)
      expect(src, f).not.toMatch(/e instanceof Error \? e\.message/)
      expect(src, f).toMatch(/t\(storageErrorKey\(e, '(export|import)\.errGeneric'\)\)/)
    }
  })
})

function tryParse(raw: string): unknown {
  try { parseVaultExport(raw); return new Error('parsed') } catch (e) { return e }
}
