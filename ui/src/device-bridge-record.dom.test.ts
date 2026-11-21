// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The bridge (no hosted helper) with a vault whose record in this browser says it is PROTECTED: the
// record decides, `IS_NET` is only the answer when there is no record. Nothing is written in the clear.
vi.setConfig({ testTimeout: 60_000 })
import * as storage from './storage'
import { saveVault, deleteVault } from './storage'
import { setSelectedVault } from './api'
import { pushRecentPayee, recentPayees } from './recent-payees'
import { savePayrollDraft } from './payroll-draft'

const GK = 'c3'.repeat(32)
const A = 'u1' + 'a'.repeat(76)
const save = (secret?: Uint8Array) => saveVault(GK, {
  name: 'v', governance: 'quorum', myName: 'Alice', creatorName: 'Alice', groupKey: new Uint8Array(32).fill(0xc3),
  address: 'u1vault', roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1), accessSecret: secret,
}, 'a long passphrase for tests')
afterEach(async () => { localStorage.clear(); await deleteVault(GK).catch(() => undefined) })

describe('a protected record on the bridge', () => {
  it('writes nothing in the clear and offers nothing', async () => {
    await save(new Uint8Array(32).fill(0x5a)); setSelectedVault(GK)
    await pushRecentPayee(A)
    expect(await savePayrollDraft(GK, { competencia: 'secret period' })).toBe('locked')
    expect(await recentPayees()).toEqual([])
    expect(Object.keys(localStorage).filter((k) => k.includes('recentPayees') || k.includes('rascunho'))).toEqual([])
  })
  it('an open record on the bridge keeps its plain bytes', async () => {
    await save(); setSelectedVault(GK)
    await pushRecentPayee(A)
    expect(localStorage.getItem(`konclave.recentPayees.${GK}`)).toBe(JSON.stringify([A]))
  })
  it('records that cannot be read count as protected, never as plain (the bridge does not decide then)', async () => {
    setSelectedVault(GK)
    const spy = vi.spyOn(storage, 'readVaults').mockRejectedValue(new Error('storage unavailable'))
    try {
      await pushRecentPayee(A)
      expect(await savePayrollDraft(GK, { competencia: 'secret period' })).toBe('locked')
      expect(Object.keys(localStorage).filter((k) => k.includes('recentPayees') || k.includes('rascunho'))).toEqual([])
    } finally { spy.mockRestore() }
  })
})
