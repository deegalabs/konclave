// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
const getProposalDetail = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getProposalDetail, getProposals: async () => [], getVault: async () => ({ id: 'v', threshold: 2, total: 3, member_list: [{ name: 'Alice' }] }), getBalance: async () => null, readTransactions: async () => [], IS_NET: false }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))
const { default: Proposal } = await import('./screens/Proposal')
const p = { id: 'p1', vault_id: 'v', proposer: 'Alice', is_public: false, approvals: ['Alice'], refusals: [], approvals_count: 1, state: 'ready', kind: 'payment', to_address: 'u1payee', value_zat: 5000, value_zec: '0.00005' }
describe('the proposal page refuses what does not hold together', () => {
  afterEach(cleanup)
  it('a payment with lines says so, and offers nothing to sign', async () => {
    localStorage.setItem('konclave.locale', 'en')
    getProposalDetail.mockResolvedValue({ proposal: p, lines: [{ address: 'u1other', value_zat: 5000, value_zec: '0.00005', memo: '', label: null, is_public: false }] })
    render(<MemoryRouter initialEntries={[{ pathname: '/proposal', state: { id: 'p1' } }]}><I18nProvider><Proposal /></I18nProvider></MemoryRouter>)
    expect(await screen.findByText('This proposal does not add up')).toBeTruthy()
    expect(screen.queryByText('u1payee')).toBeNull()
    expect(screen.queryByRole('button', { name: /sign/i })).toBeNull()
  })
})
