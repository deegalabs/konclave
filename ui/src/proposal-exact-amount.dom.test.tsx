// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #777: the proposal screen formatted the amount to four places, so a payment of 0.00009 ZEC read
// 0.0001 at the top of the page, on a payroll line and in the send confirmation, while the fee and
// the total beside it were exact and the signing panel read 0.00009. The amount sent was never
// affected. This mounts the real screen over a fake coordinator and reads the three figures.

const getProposalDetail = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getBalance = vi.hoisted(() => vi.fn())
const readTransactions = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), getProposalDetail, getProposals, getVault, getBalance, readTransactions, IS_NET: false,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: Proposal } = await import('./screens/Proposal')

const ADDR = 'u1' + 'q'.repeat(76)
const base = { vault_id: 'v', proposer: 'Alice', is_public: false, approvals: ['Alice', 'Bob'], refusals: [], approvals_count: 2, created_at: 1759300000 }
const ready = { ...base, id: 'p1', kind: 'payment', state: 'ready', memo: 'Tip', to_address: ADDR, value_zat: 9000, value_zec: '0.00009' }
const payroll = { ...base, id: 'p2', kind: 'payroll', state: 'awaiting', memo: 'Stipends', value_zat: 9000, value_zec: '0.00009', approvals: ['Alice'], approvals_count: 1 }
const line = { label: 'Carol', address: ADDR, value_zat: 9000, value_zec: '0.00009', memo: '', is_public: false }

const mount = (id: string) => render(
  <MemoryRouter initialEntries={[{ pathname: '/proposal', state: { id } }]}><I18nProvider><Proposal /></I18nProvider></MemoryRouter>,
)

describe('the proposal screen shows the amount exactly (#777)', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }], group_pubkey: 'v', orchard_address: 'u1x' })
    getBalance.mockResolvedValue({ configured: true, spendable_zat: 500000000, total_zat: 500000000 })
    readTransactions.mockResolvedValue([])
    getProposals.mockResolvedValue([ready, payroll])
    getProposalDetail.mockImplementation(async (id: string) => ({ proposal: id === 'p1' ? ready : payroll, lines: id === 'p2' ? [line] : [] }))
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  // The fee beside the amount is 0.0001 ZEC on its own (ZIP 317), so the check is on the amount's
  // elements, not on the page: the head figure and the confirmation's amount line.
  it('0.00009 ZEC reads 0.00009 at the top and in the send confirmation, never 0.0001', async () => {
    mount('p1')
    await screen.findByText('Tip')
    expect(document.querySelector('.p-amt')!.textContent).toContain('0.00009')
    expect(document.querySelector('.p-amt')!.textContent).not.toContain('0.0001')
    fireEvent.click(screen.getByRole('button', { name: en('proposal.signSendPayment') }))
    const card = (await screen.findByText(en('proposal.confirmTitle'))).closest('.modal-card') as HTMLElement
    expect(card.querySelector('.scw-amt')!.textContent).toBe('0.00009 ZEC')
  })

  it('a payroll line reads its own amount exactly too', async () => {
    mount('p2')
    await screen.findByText('Stipends')
    const cells = Array.from(document.querySelectorAll('td.num')).map((c) => c.textContent)
    expect(cells).toContain('0.00009')
    expect(cells).not.toContain('0.0001')
  })
})
