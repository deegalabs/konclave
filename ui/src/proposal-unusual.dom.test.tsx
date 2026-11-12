// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { shortAddr } from './format'
const en = (k: string, v: Record<string, string> = {}): string =>
  Object.entries(v).reduce((s, [k2, x]) => s.replace(`{${k2}}`, x), dict[k] ?? k)

// "Worth a second look" on the proposal screen: the unusual.ts rule, read against the vault's book
// while a member can still vote or sign, and said as a reading aid. Nothing is read or shown once
// the proposal is sent, and a book that cannot be read shows nothing rather than a guess.

const getProposalDetail = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getBalance = vi.hoisted(() => vi.fn())
const readTransactions = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), getProposalDetail, getProposals, getVault, getBalance, readTransactions, getLedger, IS_NET: false,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: Proposal } = await import('./screens/Proposal')
const { PAYROLLS_READ } = await import('./useUnusual')

const A = (c: string) => 'u1' + c.repeat(76)
const OLD = A('o')
const NEW = A('n')
const BIA = A('b')
const CAIO = A('c')
const base = { vault_id: 'v', proposer: 'Alice', is_public: false, approvals: ['Alice'], refusals: [], approvals_count: 1, value_zec: '' }
const paid = { ...base, id: 'old', kind: 'payment', state: 'confirmed', to_address: OLD, value_zat: 100, created_at: 1759000000 }
const toNew = { ...base, id: 'p-new', kind: 'payment', state: 'awaiting', to_address: NEW, value_zat: 100, created_at: 1759300000 }
const sentToNew = { ...toNew, id: 'p-sent', state: 'sent', txid: 'a'.repeat(64), created_at: 1759400000 }
const prevRoll = { ...base, id: 'r-prev', kind: 'payroll', state: 'confirmed', value_zat: 200, created_at: 1759000000 }
const roll = { ...base, id: 'r-now', kind: 'payroll', state: 'awaiting', value_zat: 200, created_at: 1759300000 }
const line = (label: string, address: string, value_zat: number) => ({ label, address, value_zat, value_zec: '', memo: '', is_public: false })

const mount = (id: string) => render(
  <MemoryRouter initialEntries={[{ pathname: '/proposal', state: { id } }]}><I18nProvider><Proposal /></I18nProvider></MemoryRouter>,
)

describe('the proposal names what is out of the ordinary', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Alice' }, { name: 'Bob' }], group_pubkey: 'v', orchard_address: 'u1x' })
    getBalance.mockResolvedValue({ configured: true, spendable_zat: 1e9, total_zat: 1e9, chain_tip_height: 1 })
    readTransactions.mockResolvedValue([])
    getProposals.mockResolvedValue([])
    getLedger.mockResolvedValue([paid, toNew, sentToNew])
    getProposalDetail.mockImplementation(async (id: string) => {
      const p = [toNew, sentToNew, paid].find((x) => x.id === id)
      return p ? { proposal: p, lines: [] } : null
    })
  })
  afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })

  it('a payment to an address the vault never paid, said as a reading aid', async () => {
    mount('p-new')
    expect(await screen.findByText(en('unusual.first', { who: shortAddr(NEW) }))).toBeTruthy()
    const note = screen.getByRole('region', { name: en('unusual.title') })
    expect(note.textContent).toContain(en('unusual.aid'))
  })

  it('a payroll against the previous one: who was added and who was removed, by name', async () => {
    getLedger.mockResolvedValue([prevRoll, roll])
    getProposalDetail.mockImplementation(async (id: string) =>
      id === 'r-prev' ? { proposal: prevRoll, lines: [line('Bia', BIA, 200)] }
        : { proposal: roll, lines: [line('Caio', CAIO, 200)] })
    mount('r-now')
    expect(await screen.findByText(en('unusual.added', { who: `Caio (${shortAddr(CAIO)})` }))).toBeTruthy()
    expect(screen.getByText(en('unusual.removed', { who: shortAddr(BIA) }))).toBeTruthy()
  })

  it('says the comparison is partial when older payrolls were not read', async () => {
    const many = Array.from({ length: PAYROLLS_READ + 1 }, (_, i) => ({ ...prevRoll, id: `r${i}`, created_at: 1759000000 - i }))
    getLedger.mockResolvedValue([...many, toNew])
    getProposalDetail.mockImplementation(async (id: string) =>
      id === 'p-new' ? { proposal: toNew, lines: [] } : { proposal: many.find((m) => m.id === id), lines: [line('', OLD, 200)] })
    mount('p-new')
    expect(await screen.findByText(en('unusual.incomplete'))).toBeTruthy()
    // the oldest payroll is past the cap: its lines are never asked for
    expect(getProposalDetail.mock.calls.some(([id]) => id === `r${PAYROLLS_READ}`)).toBe(false)
  })

  it('a sent payment: nothing is read and nothing is said', async () => {
    mount('p-sent')
    await screen.findByText(sentToNew.txid)
    expect(getLedger).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: en('unusual.title') })).toBeNull()
  })

  it('a book that cannot be read shows nothing rather than a guess', async () => {
    getLedger.mockResolvedValue(null)
    mount('p-new')
    await waitFor(() => expect(getLedger).toHaveBeenCalled())
    await screen.findByText(en('proposal.waitingMembers'))
    expect(screen.queryByRole('region', { name: en('unusual.title') })).toBeNull()
  })
})
