// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string, v: Record<string, string | number> = {}): string =>
  Object.entries(v).reduce((s, [k2, x]) => s.replace(`{${k2}}`, String(x)), dict[k] ?? k)

/* F and G, in the browser. F: a line copied from a previous payroll whose ADDRESS this device's
 * registry does not hold keeps Propose closed until the line's own confirm, and editing that address
 * asks again. G: a draft typed under one vault does not open under another. */

const health = vi.hoisted(() => vi.fn())
const getBeneficiaries = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const getProposalDetail = vi.hoisted(() => vi.fn())
const readBalance = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), health, getBeneficiaries, getLedger, getVault, getProposals, getProposalDetail, readBalance, IS_NET: true,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: NewPayroll } = await import('./screens/NewPayroll')
const { setSelectedVault } = await import('./api')

const KNOWN = 'u1' + 'k'.repeat(76)
const OLD = 'u1' + 'o'.repeat(76)
const NEWER = 'u1' + 'n'.repeat(76)
const ONE_ZEC = 100_000_000
const past = { id: 'f1', vault_id: 'v', kind: 'payroll', state: 'sent', proposer: 'Alice', memo: 'March payroll', is_public: false,
  approvals: ['Alice', 'Bob'], refusals: [], approvals_count: 2, value_zat: 50_000_000, value_zec: '0.5', created_at: 1_760_000_000 }

const mount = () => render(<MemoryRouter><I18nProvider><NewPayroll /></I18nProvider></MemoryRouter>)
const submit = () => screen.getByRole('button', { name: en('payroll.submitBtn') }) as HTMLButtonElement
const vouch = () => screen.queryByRole('button', { name: en('payroll.vouchBtn', { n: 1 }) }) as HTMLButtonElement | null

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('konclave.locale', 'en')
  setSelectedVault('v')
  health.mockResolvedValue(true)
  // The registry holds Ana at KNOWN; the copied line still pays her old address.
  getBeneficiaries.mockResolvedValue([{ id: '1', name: 'Ana', address: KNOWN, memo: '', is_public: false }])
  getLedger.mockResolvedValue([past])
  getProposals.mockResolvedValue([])
  getProposalDetail.mockResolvedValue({ proposal: past, lines: [{ label: 'Ana', address: OLD, value_zat: 50_000_000, value_zec: '0.5', memo: '', is_public: false }] })
  getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Alice' }, { name: 'Bob' }], group_pubkey: 'v', orchard_address: KNOWN })
  readBalance.mockResolvedValue({ configured: true, total_zat: ONE_ZEC, spendable_zat: ONE_ZEC, total_zec: '1', spendable_zec: '1' })
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('F: a copied line paying an address the registry does not hold', () => {
  it('keeps Propose closed until the line is confirmed, and asks again when its address changes', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: `${en('payroll.startFromThis')}: March payroll` }))
    await screen.findByText(en('payroll.rowStale', { name: 'Ana' }))
    // Leaving the field is not a confirmation.
    fireEvent.focusOut(document.querySelector('.plr-to .rcb-x')!)
    await waitFor(() => expect(submit().disabled).toBe(true))
    expect(document.getElementById('payroll-block')!.textContent).toBe(en('payroll.blockUnvouched', { n: 1 }))
    fireEvent.click(vouch()!)
    await waitFor(() => expect(submit().disabled).toBe(false))
    expect(vouch()).toBeNull()
    // Another address the registry does not hold: the confirm is asked again.
    fireEvent.click(document.querySelector('.plr-to .rcb-x')!)
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: NEWER } })
    await waitFor(() => expect(submit().disabled).toBe(true))
    expect(vouch()).not.toBeNull()
  })
})

describe('G: the draft belongs to one vault', () => {
  it('a draft typed under vault A does not open under vault B, and is still there for A', async () => {
    setSelectedVault('A')
    mount()
    const period = await screen.findByPlaceholderText(en('payroll.competencePlaceholder'))
    fireEvent.change(period, { target: { value: 'A-only April' } })
    await waitFor(() => expect(JSON.stringify(Object.entries(localStorage))).toContain('A-only April'))
    cleanup()
    setSelectedVault('B')
    mount()
    expect(((await screen.findByPlaceholderText(en('payroll.competencePlaceholder'))) as HTMLInputElement).value).toBe('')
    cleanup()
    setSelectedVault('A')
    mount()
    await waitFor(() => expect((screen.getByPlaceholderText(en('payroll.competencePlaceholder')) as HTMLInputElement).value).toBe('A-only April'))
  })
})
