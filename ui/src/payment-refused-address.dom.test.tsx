// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
import { addressRefusal } from './api'
import { rowIssue } from './screens/NewPayroll'
const en = (k: string): string => dict[k] ?? k

// The payment screen kept "Propose" open for an address the vault cannot pay: a pasted Sapling one,
// or a saved payee's address that is no address. The coordinator refused it, after the click. The
// payroll line already refused both; the two now ask one rule.
const ZS = 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const T1 = 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU'
const U1 = 'u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const benefs = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Vault', threshold: 2, total: 2, member_list: [] }),
  getBeneficiaries: async () => benefs.list,
  getProposals: async () => [],
  getLedger: async () => [],
  createProposal: vi.fn(),
}))
vi.mock('./useVaultBalance', async (orig) => ({
  ...(await orig<typeof import('./useVaultBalance')>()),
  useVaultBalance: () => ({ bal: { total_zat: 100_000_000, spendable_zat: 100_000_000 }, busy: false }),
}))
const { default: NewPayment } = await import('./screens/NewPayment')

const mount = () => render(<MemoryRouter><I18nProvider><ToastProvider><NewPayment /></ToastProvider></I18nProvider></MemoryRouter>)
const propose = () => screen.getByRole('button', { name: en('payment.proposeBtn') }) as HTMLButtonElement
const fill = async (addr: string) => {
  const to = await screen.findByRole('combobox')
  fireEvent.change(to, { target: { value: addr } })
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0.01' } })
}

describe('an address the vault cannot pay closes Propose and says why (#294)', () => {
  beforeEach(() => { localStorage.setItem('konclave.locale', 'en'); benefs.list = [] })
  afterEach(() => cleanup())

  it('one rule: what it refuses, and the payroll line asks the same', () => {
    expect(addressRefusal(ZS)).toBe('sapling')
    expect(addressRefusal('not an address')).toBe('unknown')
    expect(addressRefusal(U1)).toBeNull()
    // Transparent is the path's: the local bridge pays it as a warned public payment, the hosted
    // coordinator refuses any address without an Orchard receiver.
    expect(addressRefusal(T1, false)).toBeNull()
    expect(addressRefusal(T1, true)).toBe('transparent')
    const row = { label: '', value: '1', memo: '' }
    expect(rowIssue({ ...row, address: ZS })).toBe('payroll.cellSapling')
    expect(rowIssue({ ...row, address: 'not an address' })).toBe('payroll.issueUnknown')
  })

  it('a pasted Sapling address: Propose stays closed, and the field says why', async () => {
    mount()
    await fill(ZS)
    expect(screen.getByText(en('payment.toSapling'))).toBeTruthy()
    expect(propose().disabled).toBe(true)
    expect(propose().getAttribute('aria-describedby')).toContain('pay-to-refused')
  })

  it('a saved payee whose address is no address: Propose stays closed', async () => {
    benefs.list = [{ id: 'b1', name: 'Old Bia', address: 'bia-old-address', memo: '' }]
    mount()
    const to = await screen.findByRole('combobox')
    fireEvent.focus(to)
    fireEvent.change(to, { target: { value: 'Old' } })
    fireEvent.click(await screen.findByText('Old Bia'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0.01' } })
    expect(screen.getByText(en('payment.toUnknown'))).toBeTruthy()
    expect(propose().disabled).toBe(true)
  })

  it('a unified address with an amount the vault holds: Propose opens', async () => {
    mount()
    await fill(U1)
    expect(screen.queryByText(en('payment.toSapling'))).toBeNull()
    expect(propose().disabled).toBe(false)
  })
})
