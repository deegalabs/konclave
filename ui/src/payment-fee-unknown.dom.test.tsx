// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #847: the fee estimate comes from the device's rule through the wasm. While it loads, Propose is
// closed without a message; when it cannot be worked out, Propose is closed and the member is told
// why. Never a default fee.
localStorage.setItem('konclave.locale', 'en')
const fee = vi.hoisted(() => ({ state: 'loading' as 'loading' | 'unavailable' | 'ready' }))
vi.mock('./fee-estimate', async (orig) => ({
  ...(await orig<typeof import('./fee-estimate')>()),
  useFeeEstimate: () =>
    fee.state === 'ready' ? { state: 'ready', estimate: (d: number) => 5000 * Math.max(3, Math.max(1, d) + 1) } : { state: fee.state },
}))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Vault', threshold: 2, total: 2, member_list: [] }),
  getBeneficiaries: async () => [],
  getProposals: async () => [],
  createProposal: vi.fn(),
}))
vi.mock('./useVaultBalance', async (orig) => ({
  ...(await orig<typeof import('./useVaultBalance')>()),
  useVaultBalance: () => ({ bal: { total_zat: 100_000_000, spendable_zat: 100_000_000 }, busy: false }),
}))
const { default: NewPayment } = await import('./screens/NewPayment')
const { I18nProvider } = await import('./i18n')
const { ToastProvider } = await import('./toast')

const mount = async () => {
  render(<MemoryRouter><I18nProvider><ToastProvider><NewPayment /></ToastProvider></I18nProvider></MemoryRouter>)
  fireEvent.change(await screen.findByPlaceholderText('0.00'), { target: { value: '0.01' } })
  return screen.getByRole('button', { name: en('payment.proposeBtn') }) as HTMLButtonElement
}

describe('the payment screen without a fee estimate (#847)', () => {
  afterEach(() => cleanup())
  it('unavailable: Propose stays closed and says why', async () => {
    fee.state = 'unavailable'
    const btn = await mount()
    expect(await screen.findByText(en('money.blockFeeUnknown'))).toBeTruthy()
    expect(btn.disabled).toBe(true)
    expect(document.body.textContent).not.toContain('NaN')
    // The amount is fine: the field is not marked invalid, and the fee line says it is not known.
    expect(screen.getByPlaceholderText('0.00').getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByText(en('payment.feeEstimateUnknown'))).toBeTruthy()
  })
  it('loading: Propose stays closed, without telling the member to reload', async () => {
    fee.state = 'loading'
    const btn = await mount()
    expect(btn.disabled).toBe(true)
    expect(screen.queryByText(en('money.blockFeeUnknown'))).toBeNull()
  })
})
