// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// On the web the hosted coordinator pays only an address with an Orchard receiver (`payment_plan`,
// orchestrator/src/helper.rs): a transparent one kept Propose open and was refused after the click.
// The app is started on the web path here, the way a browser with a coordinator is, before any module
// reads it.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.locale', 'en')
const T1 = 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU'
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Vault', threshold: 2, total: 2, member_list: [] }),
  getBeneficiaries: async () => [],
  getProposals: async () => [],
  getLedger: async () => [],
  createProposal: vi.fn(),
}))
vi.mock('./useVaultBalance', async (orig) => ({
  ...(await orig<typeof import('./useVaultBalance')>()),
  useVaultBalance: () => ({ bal: { total_zat: 100_000_000, spendable_zat: 100_000_000 }, busy: false }),
}))
const { IS_NET, addressRefusal } = await import('./api')
const { rowIssue } = await import('./screens/NewPayroll')
const { default: NewPayment } = await import('./screens/NewPayment')
const { I18nProvider } = await import('./i18n')
const { ToastProvider } = await import('./toast')

describe('on the web, a transparent address is refused before the click (#294)', () => {
  afterEach(() => cleanup())

  it('the app is on the web path, and the rule and the payroll line refuse it', () => {
    expect(IS_NET).toBe(true)
    expect(addressRefusal(T1)).toBe('transparent')
    expect(rowIssue({ label: '', address: T1, value: '1', memo: '' })).toBe('payroll.cellTransparent')
  })

  it('the payment field says why, and Propose stays closed', async () => {
    render(<MemoryRouter><I18nProvider><ToastProvider><NewPayment /></ToastProvider></I18nProvider></MemoryRouter>)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: T1 } })
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0.01' } })
    expect(screen.getByText(en('payment.toTransparent'))).toBeTruthy()
    expect((screen.getByRole('button', { name: en('payment.proposeBtn') }) as HTMLButtonElement).disabled).toBe(true)
  })
})
