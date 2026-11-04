// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { draftKey, clearPayrollDraft, LEGACY_DRAFT_KEY } from './payroll-draft'
import { codeOf } from './source-scan'

// G: the payroll draft (addresses, amounts, memos) sat under ONE key for every vault, so a draft
// typed in vault A opened in vault B, and it outlived both the lock and the vault's removal.
afterEach(() => localStorage.clear())

describe('the payroll draft belongs to one vault', () => {
  it('is keyed by vault id', () => {
    expect(draftKey('A')).not.toBe(draftKey('B'))
    expect(draftKey('A')).not.toBe(LEGACY_DRAFT_KEY)
  })

  it('clearing one vault\'s draft leaves another\'s, and drops the unkeyed legacy one', () => {
    localStorage.setItem(draftKey('A'), '{}')
    localStorage.setItem(draftKey('B'), '{}')
    localStorage.setItem(LEGACY_DRAFT_KEY, '{}')
    clearPayrollDraft('A')
    expect(localStorage.getItem(draftKey('A'))).toBeNull()
    expect(localStorage.getItem(draftKey('B'))).toBe('{}')
    expect(localStorage.getItem(LEGACY_DRAFT_KEY)).toBeNull()
  })

  it('the screen reads and writes only the keyed draft', () => {
    const src = codeOf('screens/NewPayroll.tsx')
    expect(src).not.toMatch(/konclave\.folha\.rascunho/)
    expect(src).toMatch(/draftKey\(/)
  })

  it('is cleared on lock and on every removal path', () => {
    expect(codeOf('Layout.tsx')).toMatch(/clearPayrollDraft\(v\.id\)/)
    const store = codeOf('storage.ts')
    expect(store.slice(store.indexOf('export async function deleteVault'))).toMatch(/clearPayrollDraft\(id\)/)
    expect(codeOf('screens/Settings.tsx')).toMatch(/clearPayrollDraft\(vault\.id\)/)
  })
})
