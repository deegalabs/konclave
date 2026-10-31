// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { fmtDateTime } from './format'
const en = (k: string): string => dict[k] ?? k

// The proposal screen carries facts it had and did not show: when it was created, until when it
// can be approved, the whole destination address (with a copy button), and how many blocks sit on
// top of a sent payment. This mounts the real screen over a fake coordinator and reads them.

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

const TX1 = 'a'.repeat(64)
const ADDR = 'u1' + 'q'.repeat(76)
const base = { vault_id: 'v', proposer: 'Alice', is_public: false, approvals: ['Alice', 'Bob'], refusals: [], approvals_count: 2, kind: 'payment', to_address: ADDR, value_zat: 150000000, value_zec: '1.5' }
const sent = { ...base, id: 'p1', state: 'sent', memo: 'October rent', created_at: 1759300000, txid: TX1 }
const awaiting = { ...base, id: 'p2', state: 'awaiting', memo: 'Chairs', created_at: 1759300000, expiry_unix: Math.floor(Date.now() / 1000) + 3 * 86400, approvals: ['Alice'], approvals_count: 1 }

const mount = (id: string) => render(
  <MemoryRouter initialEntries={[{ pathname: '/proposal', state: { id } }]}><I18nProvider><Proposal /></I18nProvider></MemoryRouter>,
)

describe('the proposal screen states its facts', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }], group_pubkey: 'v', orchard_address: 'u1x' })
    getBalance.mockResolvedValue({ configured: true, spendable_zat: 500000000, total_zat: 500000000, chain_tip_height: 3500120 })
    readTransactions.mockResolvedValue([{ txid: TX1, mined_height: 3500100 }])
    getProposals.mockResolvedValue([sent, awaiting])
    getProposalDetail.mockImplementation(async (id: string) => ({ proposal: id === 'p1' ? sent : awaiting, lines: [] }))
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('a sent payment: creation date, the whole address, and how many confirmations it has', async () => {
    mount('p1')
    await screen.findByText('October rent')
    expect(await screen.findByText(fmtDateTime(sent.created_at, 'en'))).toBeTruthy()
    expect(screen.getByText(ADDR)).toBeTruthy()
    expect(await screen.findByText(en('proposal.confirmationsN').replace('{n}', '21'))).toBeTruthy()
    expect(screen.getByRole('link', { name: en('proposal.viewEvidence') })).toBeTruthy() // the sent payment points at its evidence
  })

  it('the count moves while the screen is open: the tip is re-read with the list on each poll', async () => {
    mount('p1')
    expect(await screen.findByText(en('proposal.confirmationsN').replace('{n}', '21'))).toBeTruthy()
    // Ten more blocks on the chain. The poll re-reads the list AND the tip; a tip read once at mount
    // left the count standing still while the list moved. Regaining focus runs the poll at once.
    getBalance.mockResolvedValue({ configured: true, spendable_zat: 500000000, total_zat: 500000000, chain_tip_height: 3500130 })
    window.dispatchEvent(new Event('focus'))
    expect(await screen.findByText(en('proposal.confirmationsN').replace('{n}', '31'))).toBeTruthy()
  })

  it('an awaiting payment: until when it can be approved', async () => {
    mount('p2')
    await screen.findByText('Chairs')
    expect(screen.getByText(en('proposal.factDeadline'))).toBeTruthy()
    expect(screen.getByText(fmtDateTime(awaiting.expiry_unix, 'en'), { exact: false })).toBeTruthy()
    expect(screen.getByText(en('expiry.days').replace('{d}', '2'))).toBeTruthy()
  })

  it('one confirmation is singular, and a list that could not be read is said as such', async () => {
    readTransactions.mockResolvedValue([{ txid: TX1, mined_height: 3500120 }])
    mount('p1')
    expect(await screen.findByText(en('proposal.confirmationsOne'))).toBeTruthy()
    cleanup()
    readTransactions.mockResolvedValue(null)
    mount('p1')
    expect(await screen.findByText(en('proposal.confirmationsUnknown'))).toBeTruthy()
  })
})
