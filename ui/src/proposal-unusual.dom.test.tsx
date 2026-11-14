// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { shortAddr } from './format'
// A missing key fails here instead of passing as its own name.
const en = (k: string, v: Record<string, string> = {}): string => {
  const s = dict[k]
  if (s === undefined) throw new Error(`no English text for ${k}`)
  return Object.entries(v).reduce((acc, [name, x]) => acc.replace(`{${name}}`, x), s)
}

// "Worth a second look" on the proposal screen: the unusual.ts rule, read against the vault's book
// while a member can still vote or sign, and said as a reading aid. Reading and a failed read are
// said, so the note's absence only means the comparison ran and found nothing.

const getProposalDetail = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getBalance = vi.hoisted(() => vi.fn())
const readTransactions = vi.hoisted(() => vi.fn())
const getBookWithLines = vi.hoisted(() => vi.fn())
const polls = vi.hoisted(() => [] as Array<() => void>)
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), getProposalDetail, getProposals, getVault, getBalance, readTransactions, getBookWithLines, IS_NET: false,
}))
vi.mock('./usePoll', async (orig) => ({
  ...(await orig<typeof import('./usePoll')>()),
  usePoll: (fn: () => void, _ms: number, on = true) => { if (on) polls.push(fn) },
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: Proposal } = await import('./screens/Proposal')
const { SHOWN } = await import('./UnusualNote')

const A = (c: string) => 'u1' + c.repeat(76)
const OLD = A('o')
const NEW = A('n')
const BIA = A('b')
const CAIO = A('c')
const base = { vault_id: 'v', proposer: 'Alice', is_public: false, approvals: ['Alice'], refusals: [], approvals_count: 1, value_zec: '' }
const payment = (id: string, to: string, value_zat: number, created_at: number, state = 'confirmed') =>
  ({ ...base, id, kind: 'payment', state, to_address: to, value_zat, created_at })
const payroll = (id: string, created_at: number, state = 'confirmed') => ({ ...base, id, kind: 'payroll', state, value_zat: 0, created_at })
const line = (label: string, address: string, value_zat: number) => ({ label, address, value_zat, value_zec: '', memo: '', is_public: false })

const T0 = 1759000000
const toNew = payment('p-new', NEW, 100, T0 + 100, 'awaiting')
// A fresh id per test: the screen pins the first plan it read for an id (readPlan), so a payroll id
// reused with other lines would be refused as a proposal that changed.
let seq = 0
let roll = payroll('r-now', T0 + 100, 'awaiting')

type Detail = { proposal: Record<string, unknown>; lines: ReturnType<typeof line>[] }
// A payroll's total is its lines' sum, as the screen's own check (readPlan) requires.
const detailOf = (d: Detail) => {
  const proposal = d.proposal.kind === 'payroll' ? { ...d.proposal, value_zat: d.lines.reduce((a, l) => a + l.value_zat, 0) } : d.proposal
  // A fresh object per read, as a real read is: the poll hands the screen a new proposal each time.
  getProposalDetail.mockImplementation(async (id: string) => (id === proposal.id ? { proposal: { ...proposal }, lines: d.lines.map((l) => ({ ...l })) } : null))
}
const bookOf = (history: unknown[], linesById: Record<string, ReturnType<typeof line>[]> = {}) => getBookWithLines.mockResolvedValue({ history, linesById })
const note = () => screen.queryByRole('region', { name: en('unusual.title') })

const mount = (id: string) => render(
  <MemoryRouter initialEntries={[{ pathname: '/proposal', state: { id } }]}><I18nProvider><Proposal /></I18nProvider></MemoryRouter>,
)

describe('the proposal names what is out of the ordinary', () => {
  beforeEach(() => {
    roll = payroll(`r-now-${seq++}`, T0 + 100, 'awaiting')
    localStorage.setItem('konclave.locale', 'en')
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Alice' }, { name: 'Bob' }], group_pubkey: 'v', orchard_address: 'u1x' })
    getBalance.mockResolvedValue({ configured: true, spendable_zat: 1e9, total_zat: 1e9, chain_tip_height: 1 })
    readTransactions.mockResolvedValue([])
    getProposals.mockResolvedValue([])
    detailOf({ proposal: toNew, lines: [] })
    bookOf([payment('old', OLD, 100, T0), toNew])
  })
  afterEach(() => { cleanup(); localStorage.clear(); polls.length = 0; vi.clearAllMocks() })

  it('a payment to an address the book never paid, with the device first in the disclaimer', async () => {
    mount('p-new')
    expect(await screen.findByText(en('unusual.first', { who: shortAddr(NEW) }))).toBeTruthy()
    expect(note()!.textContent).toContain(en('unusual.aid'))
    expect(en('unusual.aid').startsWith('What your device reads')).toBe(true)
  })

  it('an amount over twice what the address usually receives', async () => {
    const big = payment('p-big', OLD, 1000, T0 + 100, 'awaiting')
    detailOf({ proposal: big, lines: [] })
    bookOf([payment('a', OLD, 100, T0), payment('b', OLD, 100, T0 + 1), payment('c', OLD, 100, T0 + 2), big])
    mount('p-big')
    expect(await screen.findByText(en('unusual.above', { who: shortAddr(OLD) }))).toBeTruthy()
  })

  it('a payroll: the one who left is named as the previous payroll named them, and a changed amount is said', async () => {
    detailOf({ proposal: roll, lines: [line('Caio', CAIO, 200), line('Oto', OLD, 300)] })
    bookOf([payment('paid-caio', CAIO, 50, T0 - 10), payroll('r-prev', T0), roll],
      { 'r-prev': [line('Bia', BIA, 200), line('Oto', OLD, 200)] })
    mount(roll.id)
    expect(await screen.findByText(en('unusual.added', { who: `Caio (${shortAddr(CAIO)})` }))).toBeTruthy()
    expect(screen.getByText(en('unusual.removed', { who: `Bia (${shortAddr(BIA)})` }))).toBeTruthy()
    expect(screen.getByText(en('unusual.amount', { who: `Oto (${shortAddr(OLD)})` }))).toBeTruthy()
  })

  it('a newcomer to a payroll gets one line, not two', async () => {
    detailOf({ proposal: roll, lines: [line('Caio', CAIO, 200), line('Bia', BIA, 200)] })
    bookOf([payroll('r-prev', T0), roll], { 'r-prev': [line('Bia', BIA, 200)] })
    mount(roll.id)
    const who = `Caio (${shortAddr(CAIO)})`
    expect(await screen.findByText(en('unusual.first', { who }))).toBeTruthy()
    expect(screen.queryByText(en('unusual.added', { who }))).toBeNull()
  })

  it("a vault's first payroll is one sentence, not a line per person", async () => {
    detailOf({ proposal: roll, lines: [line('Bia', BIA, 1), line('Caio', CAIO, 1), line('', NEW, 1)] })
    bookOf([roll])
    mount(roll.id)
    expect(await screen.findByText(en('unusual.allNew', { n: '3' }))).toBeTruthy()
    expect(note()!.querySelectorAll('li')).toHaveLength(0)
  })

  it(`past ${SHOWN} lines, the rest is counted`, async () => {
    const people = Array.from({ length: SHOWN + 2 }, (_, i) => line(`P${i}`, A(String.fromCharCode(100 + i)), 1))
    detailOf({ proposal: roll, lines: people })
    bookOf([payment('old', OLD, 1, T0), payroll('r-prev', T0 + 1), roll], { 'r-prev': [line('Oto', OLD, 1)] })
    mount(roll.id)
    expect(await screen.findByText(en('unusual.more', { n: '3' }))).toBeTruthy()
    expect(note()!.querySelectorAll('li')).toHaveLength(SHOWN + 1)
  })

  it('says the comparison is partial when a settled payroll came without its lines', async () => {
    bookOf([payroll('r-old', T0), toNew], {})
    mount('p-new')
    expect(await screen.findByText(en('unusual.incomplete'))).toBeTruthy()
  })

  it('says it is comparing while the book is being read, inside a region already listening', async () => {
    getBookWithLines.mockReturnValue(new Promise(() => {}))
    const { container } = mount('p-new')
    const line1 = await screen.findByText(en('unusual.reading'))
    expect(line1.closest('[aria-live="polite"]')).toBeTruthy()
    expect(container.querySelector('[aria-live="polite"][role]')).toBeNull()
  })

  it('a book that cannot be read is said, never shown as nothing to look at', async () => {
    getBookWithLines.mockResolvedValue(null)
    mount('p-new')
    expect(await screen.findByText(en('unusual.failed'))).toBeTruthy()
    expect(note()).toBeNull()
  })

  it('reads the book once: the poll that refreshes the proposal does not read it again', async () => {
    mount('p-new')
    await screen.findByText(en('unusual.first', { who: shortAddr(NEW) }))
    await act(async () => { for (const poll of [...polls]) poll(); await Promise.resolve() })
    await waitFor(() => expect(getProposalDetail.mock.calls.length).toBeGreaterThan(1))
    expect(getBookWithLines).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en('unusual.first', { who: shortAddr(NEW) }))).toBeTruthy()
  })

  it('a sent payment: nothing is read and nothing is said', async () => {
    const sent = { ...payment('p-sent', NEW, 100, T0 + 200, 'sent'), txid: 'a'.repeat(64) }
    detailOf({ proposal: sent, lines: [] })
    mount('p-sent')
    await screen.findByText(sent.txid)
    expect(getBookWithLines).not.toHaveBeenCalled()
    expect(screen.queryByText(en('unusual.reading'))).toBeNull()
  })
})
