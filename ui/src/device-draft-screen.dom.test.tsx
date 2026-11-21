// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'

// The payroll screen of a PROTECTED vault: every write path (typing, the CSV, a restore) keeps the
// draft in memory, and storage sees none of it. A restore is async now, so it gives a `restored` signal
// before anything is written back.
vi.hoisted(() => { vi.stubEnv('VITE_HELPER_BASE', 'https://helper.test') })
vi.setConfig({ testTimeout: 60_000 })

const health = vi.hoisted(() => vi.fn())
const getBeneficiaries = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const readBalance = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
vi.mock('./fee-estimate', async (orig) => ({
  ...(await orig<typeof import('./fee-estimate')>()),
  useFeeEstimate: () => ({ state: 'ready', estimate: (d: number) => 5000 * Math.max(3, Math.max(1, d) + 1) }),
}))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health, getBeneficiaries, getLedger, getVault, readBalance, getProposals }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: NewPayroll } = await import('./screens/NewPayroll')
const { setSelectedVault } = await import('./api')
const { saveVault, loadVault, deleteVault } = await import('./storage')
const { setUnlockedShare, clearUnlockedShare } = await import('./session')

const GK = 'c3'.repeat(32)
const PASS = 'a long passphrase for tests'
const S = new Uint8Array(32).fill(0x5a)
const everything = () => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n')
const mount = () => render(<MemoryRouter><I18nProvider><NewPayroll /></I18nProvider></MemoryRouter>)
const comp = () => screen.getByPlaceholderText(dict['payroll.competencePlaceholder']!) as HTMLInputElement

beforeEach(async () => {
  clearUnlockedShare(GK); localStorage.clear(); localStorage.setItem('konclave.locale', 'en')
  await deleteVault(GK).catch(() => undefined)
  await saveVault(GK, {
    name: 'v', governance: 'quorum', myName: 'Alice', creatorName: 'Alice', groupKey: new Uint8Array(32).fill(0xc3),
    address: 'u1vault', roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1), accessSecret: S,
  }, PASS)
  setSelectedVault(GK)
  setUnlockedShare(GK, await loadVault(GK, PASS))
  health.mockResolvedValue(true); getBeneficiaries.mockResolvedValue([]); getLedger.mockResolvedValue([]); getProposals.mockResolvedValue([])
  getVault.mockResolvedValue({ id: GK, name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Alice' }], group_pubkey: GK, orchard_address: 'u1x' })
  readBalance.mockResolvedValue({ configured: true, spendable_zat: 500000000, total_zat: 500000000 })
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('the payroll screen of a protected vault', () => {
  it('typing writes nothing to storage, and a remount in the same unlocked session restores it from memory', async () => {
    const first = mount()
    await screen.findByRole('button', { name: dict['payroll.addRow'] })
    fireEvent.change(comp(), { target: { value: 'March secret period' } })
    await new Promise((r) => setTimeout(r, 200))
    expect(everything()).not.toContain('March secret period')
    expect(Object.keys(localStorage).filter((k) => k.includes('rascunho'))).toEqual([])
    first.unmount()
    mount()
    await screen.findByRole('button', { name: dict['payroll.addRow'] })
    await waitFor(() => expect(comp().value).toBe('March secret period'))
    expect(everything()).not.toContain('March secret period')
  })

  it('a plain draft left on disk by an earlier version is brought into memory on unlock and removed from disk', async () => {
    localStorage.setItem(`konclave.folha.rascunho.${GK}`, JSON.stringify({ competencia: 'old plain period', rows: [] }))
    setUnlockedShare(GK, await loadVault(GK, PASS)) // an unlock after the upgrade
    await waitFor(() => expect(localStorage.getItem(`konclave.folha.rascunho.${GK}`)).toBeNull())
    mount()
    await screen.findByRole('button', { name: dict['payroll.addRow'] })
    await waitFor(() => expect(comp().value).toBe('old plain period'))
    expect(everything()).not.toContain('old plain period')
  })

  it('the saved mark says the draft is kept for this session when it is only in memory, and not at all when nothing was written', async () => {
    mount()
    await screen.findByRole('button', { name: dict['payroll.addRow'] })
    fireEvent.change(comp(), { target: { value: 'x' } })
    await waitFor(() => expect(document.querySelector('.draft-note')).not.toBeNull())
    expect(document.querySelector('.draft-note')!.getAttribute('title')).toBe(dict['payroll.draftKeptTitle'])
    cleanup()
    clearUnlockedShare(GK) // locked: the write answers locked
    mount()
    await screen.findByRole('button', { name: dict['payroll.addRow'] })
    fireEvent.change(comp(), { target: { value: 'y' } })
    await new Promise((r) => setTimeout(r, 150))
    expect(document.querySelector('.draft-note')).toBeNull()
  })

  it('a draft held in memory does not come back after a lock and a new unlock', async () => {
    const { savePayrollDraft, readPayrollDraft } = await import('./payroll-draft')
    await savePayrollDraft(GK, { competencia: 'kept only while unlocked' })
    clearUnlockedShare(GK)
    setUnlockedShare(GK, await loadVault(GK, PASS))
    expect(await readPayrollDraft(GK)).toBeNull()
  })

  const openVault = async () => {
    clearUnlockedShare(GK)
    await deleteVault(GK)
    await saveVault(GK, {
      name: 'v', governance: 'quorum', myName: 'Alice', creatorName: 'Alice', groupKey: new Uint8Array(32).fill(0xc3),
      address: 'u1vault', roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1),
    }, PASS)
  }

  it('an open vault: no write lands before the restore, so the stored draft is never overwritten by the empty form', async () => {
    await openVault()
    const key = `konclave.folha.rascunho.${GK}`
    localStorage.setItem(key, JSON.stringify({ competencia: 'saved earlier', description: '', rows: [{ label: '', address: '', value: '', memo: '' }], copiedFrom: null }))
    const writes: string[] = []
    const orig = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) { if (k === key) writes.push(v); return orig.call(this, k, v) })
    try {
      mount()
      await waitFor(() => expect(comp().value).toBe('saved earlier'))
      await new Promise((r) => setTimeout(r, 150))
    } finally { spy.mockRestore() }
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(JSON.parse(w).competencia).toBe('saved earlier')
  })

  it('an open vault whose write fails shows no saved mark', async () => {
    await openVault()
    mount()
    await screen.findByRole('button', { name: dict['payroll.addRow'] })
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    try {
      fireEvent.change(comp(), { target: { value: 'z' } })
      await new Promise((r) => setTimeout(r, 150))
    } finally { spy.mockRestore() }
    expect(document.querySelector('.draft-note')).toBeNull()
  })

  it('the autosave waits for the restore (pinned in the source)', async () => {
    const { codeOf } = await import('./source-scan')
    expect(codeOf('screens/NewPayroll.tsx')).toMatch(/!draftVault \|\| locked \|\| !restored/)
  })
})
