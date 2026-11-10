// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// B: open proposals not read yet counted as nothing reserved (`reservedZatOf(null)` was 0), so the
// payment screen offered the whole balance while the reservation was unknown. Unread blocks.
localStorage.setItem('konclave.locale', 'en')
vi.mock('./fee-estimate', async (orig) => ({
  ...(await orig<typeof import('./fee-estimate')>()),
  // The real estimate needs the wasm, which jsdom does not load; this is the rule's figure (fee-estimate.test.ts).
  useFeeEstimate: () => ({ state: 'ready', estimate: (d: number) => 5000 * Math.max(3, Math.max(1, d) + 1) }),
}))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Vault', threshold: 2, total: 2, member_list: [] }),
  getBeneficiaries: async () => [],
  getProposals: async () => null,
  createProposal: vi.fn(),
}))
vi.mock('./useVaultBalance', async (orig) => ({
  ...(await orig<typeof import('./useVaultBalance')>()),
  useVaultBalance: () => ({ bal: { total_zat: 100_000_000, spendable_zat: 100_000_000 }, busy: false }),
}))
const { default: NewPayment } = await import('./screens/NewPayment')
const { I18nProvider } = await import('./i18n')
const { ToastProvider } = await import('./toast')

describe('an unread list of open proposals blocks Propose (B)', () => {
  afterEach(() => cleanup())
  it('says so, and the button stays closed', async () => {
    render(<MemoryRouter><I18nProvider><ToastProvider><NewPayment /></ToastProvider></I18nProvider></MemoryRouter>)
    fireEvent.change(await screen.findByPlaceholderText('0.00'), { target: { value: '0.01' } })
    expect(await screen.findByText(en('money.blockReservedUnknown'))).toBeTruthy()
    expect((screen.getByRole('button', { name: en('payment.proposeBtn') }) as HTMLButtonElement).disabled).toBe(true)
  })
})
