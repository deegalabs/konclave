// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'

// The local bridge (no hosted helper): the browser keeps its recent addresses and payroll draft as it
// always did, byte for byte, with no vault record here to consult.
import { setSelectedVault, getSelectedVault } from './api'
import { recentPayees, pushRecentPayee } from './recent-payees'
import { readPayrollDraft, savePayrollDraft, clearPayrollDraft } from './payroll-draft'

const ID = 'bridge-vault-id'
const A = 'u1' + 'a'.repeat(76)
afterEach(() => localStorage.clear())

describe('on the local bridge', () => {
  it('recent addresses are a plain list, as before', async () => {
    setSelectedVault(ID)
    await pushRecentPayee(getSelectedVault(), A)
    expect(localStorage.getItem(`konclave.recentPayees.${ID}`)).toBe(JSON.stringify([A]))
    expect(await recentPayees(getSelectedVault())).toEqual([A])
  })
  it('the draft is plain JSON in its own key, as before, and clears', async () => {
    setSelectedVault(ID)
    const d = { competencia: 'x', description: 'y', rows: [{ address: A }], copiedFrom: null }
    await savePayrollDraft(ID, d)
    expect(localStorage.getItem(`konclave.folha.rascunho.${ID}`)).toBe(JSON.stringify(d))
    expect(await readPayrollDraft(ID)).toEqual(d)
    clearPayrollDraft(ID)
    expect(localStorage.getItem(`konclave.folha.rascunho.${ID}`)).toBeNull()
  })
})
