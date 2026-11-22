// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { withStances } from './test-stances'
const en = (k: string): string => dict[k] ?? k

// #575. A coordinator older than the count sends no `stances`. That is UNKNOWN, not "nobody has
// voted": read as an empty list, every member shows as pending and a member who already approved is
// offered Approve and Refuse again, and the old coordinator would flip that vote.

const getProposalDetail = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), getProposalDetail, getProposals: async () => [],
  getVault: async () => ({ id: 'v', name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Alice' }, { name: 'Bob' }] }),
  getBalance: async () => null, readTransactions: async () => [], IS_NET: false,
}))
// This device is Alice, who proposed and so already approved.
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [{ id: 'v', myName: 'Alice' }] }))
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))
const { default: Proposal } = await import('./screens/Proposal')

const ADDR = 'u1' + 'q'.repeat(76)
const common = { id: 'p1', vault_id: 'v', proposer: 'Alice', is_public: false, refusals: [], kind: 'payment', state: 'awaiting', memo: 'Chairs',
  to_address: ADDR, value_zat: 150000000, value_zec: '1.5', created_at: 1759300000, expiry_unix: Math.floor(Date.now() / 1000) + 86400 }
const known = withStances({ ...common, approvals: ['Alice'] })
const unknown = { ...common, approvals: ['Alice'], approvals_count: null, stances: null }

const mount = () => render(<MemoryRouter initialEntries={[{ pathname: '/proposal', state: { id: 'p1' } }]}><I18nProvider><Proposal /></I18nProvider></MemoryRouter>)

describe('a proposal from a coordinator that does not say who voted', () => {
  beforeEach(() => localStorage.setItem('konclave.locale', 'en'))
  afterEach(cleanup)

  it('offers no vote, lists no one as pending, claims no count, and says the server must be updated', async () => {
    getProposalDetail.mockResolvedValue({ proposal: unknown, lines: [] })
    mount()
    await screen.findByText('Chairs')
    expect(await screen.findByText(en('proposal.voteUnknown'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: en('proposal.approve') })).toBeNull()
    expect(screen.queryByRole('button', { name: en('proposal.refuse') })).toBeNull()
    expect(document.querySelectorAll('.who-row').length).toBe(0)
    expect(document.querySelector('.who-head .prog')).toBeNull()
    expect(screen.getByText(en('proposal.ofN').replace('{count}', '—').replace('{total}', '2'))).toBeTruthy()
  })

  it('with stances, nothing changes: the member who approved is told so and has no buttons; a pending one has them', async () => {
    getProposalDetail.mockResolvedValue({ proposal: known, lines: [] })
    mount()
    await screen.findByText('Chairs')
    expect(screen.queryByText(en('proposal.voteUnknown'))).toBeNull()
    expect(document.querySelectorAll('.who-row').length).toBe(2)
    expect(await screen.findByText(en('proposal.alreadyVoted'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: en('proposal.approve') })).toBeNull()
  })
})
