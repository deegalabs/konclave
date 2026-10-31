// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { explorerTxUrl, fmtDate } from './format'
import type { LedgerXlsxData } from './ledgerXlsx'
import { recordRead } from './read-failure'
const en = (k: string): string => dict[k] ?? k

// #302: the XLSX export iterated every row in memory, so a book filtered on screen exported
// everything, silently, and no row carried its txid or memo. This mounts the real screen in a
// simulated browser over a fake book, sets the filters a treasurer would, clicks Export, and reads
// what the export was handed.
const exportLedgerXlsx = vi.hoisted(() => vi.fn<(d: LedgerXlsxData) => Promise<void>>(async () => {}))
vi.mock('./ledgerXlsx', async (orig) => ({ ...(await orig<typeof import('./ledgerXlsx')>()), exportLedgerXlsx }))
const exportLedgerCsv = vi.hoisted(() => vi.fn<(d: LedgerXlsxData, locale: 'pt-BR' | 'en') => Promise<void>>(async () => {}))
vi.mock('./ledgerCsv', async (orig) => ({ ...(await orig<typeof import('./ledgerCsv')>()), exportLedgerCsv }))
const getLedger = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getProposalDetail = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), getLedger, getVault, getProposalDetail, ledgerCsvUrl: () => '#', IS_NET: false,
}))

const { default: Ledger } = await import('./screens/Ledger')

const TX1 = 'a'.repeat(64)
const TX3 = 'b'.repeat(64)
const base = { vault_id: 'v', proposer: 'Alice', is_public: false, approvals: ['Alice', 'Bob'], refusals: [], approvals_count: 2 }
const rent = { ...base, id: 'p1', kind: 'payment', state: 'confirmed', memo: 'October rent', to_address: 'u1rent', value_zat: 150000000, value_zec: '1.5', created_at: 1759300000, txid: TX1 }
const pending = { ...base, id: 'p2', kind: 'payment', state: 'awaiting', memo: '', to_address: 'u1open', value_zat: 25000000, value_zec: '0.25', created_at: 1760000000, approvals: ['Alice'], approvals_count: 1 }
const payroll = { ...base, id: 'p3', kind: 'payroll', state: 'sent', memo: 'Payroll October', value_zat: 200000000, value_zec: '2', created_at: 1759500000, txid: TX3 }
const lines = [
  { label: 'Alice', address: 'u1alice', value_zat: 120000000, value_zec: '1.2', memo: 'Alice Oct', is_public: false },
  { label: 'Bob', address: 'u1bob', value_zat: 80000000, value_zec: '0.8', memo: '', is_public: false },
]

const mount = () => render(<MemoryRouter><I18nProvider><Ledger /></I18nProvider></MemoryRouter>)
const exported = (): LedgerXlsxData => exportLedgerXlsx.mock.lastCall![0]
const clickExport = async () => {
  fireEvent.click(screen.getByRole('button', { name: en('ledger.exportXlsx') }))
  await waitFor(() => expect(exportLedgerXlsx).toHaveBeenCalled())
}

describe('the Ledger screen exports what it shows (#302)', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    exportLedgerXlsx.mockClear()
    getLedger.mockResolvedValue([pending, payroll, rent])
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: 'v', orchard_address: 'u1x' })
    getProposalDetail.mockResolvedValue({ proposal: payroll, lines })
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('hands the whole book to the export when nothing is filtered, each row with its memo and txid', async () => {
    mount()
    await screen.findByText('October rent')
    await clickExport()
    const d = exported()
    expect(d.filter).toBe('')
    expect(d.vaultName).toBe('Caixa')
    expect(d.generatedAt).toBeInstanceOf(Date)
    expect(d.items.map((i) => [i.kind, i.beneficiary, i.memo, i.txid])).toEqual([
      [en('kind.payment'), '', '', ''],
      [en('kind.payroll'), 'Alice', 'Alice Oct', TX3],
      [en('kind.payroll'), 'Bob', '', TX3],
      [en('kind.payment'), '', 'October rent', TX1],
    ])
  })

  it('hands only the rows on screen when the filters are set, and says which filters', async () => {
    mount()
    await screen.findByText('October rent')
    fireEvent.click(screen.getByRole('button', { name: en('ledger.filterSettled') }))
    fireEvent.click(screen.getByRole('button', { name: en('ledger.filterPayments') }))
    expect(screen.queryByText('Payroll October')).toBeNull()
    await clickExport()
    const d = exported()
    expect(d.items).toHaveLength(1)
    expect(d.items[0]).toMatchObject({ memo: 'October rent', txid: TX1, settled: true })
    expect(d.filter).toBe(`${en('ledger.filterSettled')} · ${en('ledger.filterPayments')}`)
    expect(d.period).toBe(fmtDate(rent.created_at, 'en'))
  })

  it('shows a row and the totals to the zatoshi, not rounded to four places (#303)', async () => {
    const stipend = { ...rent, id: 'p4', memo: 'Stipend', to_address: 'u1stip', value_zat: 1234, value_zec: '0.00001234' }
    getLedger.mockResolvedValue([stipend, pending])
    mount()
    await screen.findByText('Stipend')
    expect(screen.getAllByText('−0.00001234').length).toBe(2) // the row, and the band's "Settled out"
    expect(screen.getByText('0.2500')).toBeTruthy() // the band's "Open": four places at least, zeros past them trimmed
  })

  it('links a settled row to the same explorer page the export does', async () => {
    mount()
    await screen.findByText('October rent')
    const link = screen.getByRole('link', { name: `${en('state.confirmed')} ↗` })
    expect(link.getAttribute('href')).toBe(explorerTxUrl(TX1))
  })

  it('says, beside the export, that the file carries the memo and txid of each payment', async () => {
    mount()
    await screen.findByText('October rent')
    expect(screen.getByText(en('ledger.xlsxIncludes'))).toBeTruthy()
    expect(screen.getByRole('button', { name: en('ledger.exportXlsx') }).getAttribute('title')).toBe(en('ledger.xlsxIncludes'))
  })
  it("marks each row open by the screen's own rule, so a refused proposal is neither settled nor open", async () => {
    const refused = { ...base, id: 'p4', kind: 'payment', state: 'rejected', memo: 'Refused office chairs', to_address: 'u1no', value_zat: 75000000, value_zec: '0.75', created_at: 1760100000, approvals: [], refusals: ['Alice', 'Bob'], approvals_count: 0 }
    getLedger.mockResolvedValue([pending, refused, rent])
    mount()
    await screen.findByText('Refused office chairs')
    await clickExport()
    expect(exported().items.map((i) => [i.memo, i.settled, i.open])).toEqual([
      ['', false, true], // awaiting: can still move
      ['Refused office chairs', false, false], // closed without payment
      ['October rent', true, false],
    ])
  })
  it('hands the export who proposed and who approved each row, as the vault records them', async () => {
    mount()
    await screen.findByText('October rent')
    await clickExport()
    expect(exported().items.map((i) => [i.proposer, i.approvers])).toEqual([
      ['Alice', 'Alice'], // the awaiting payment: the proposer approved, nobody else yet
      ['Alice', 'Alice, Bob'], // the payroll, one row per line
      ['Alice', 'Alice, Bob'],
      ['Alice', 'Alice, Bob'], // the confirmed rent
    ])
  })
  it('narrows the book to a chosen period, by creation date, and the export follows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2025, 10, 15, 12)) // the fixture's entries are all in October 2025
    try {
      mount()
      await screen.findByText('October rent')
      fireEvent.click(screen.getByRole('button', { name: en('ledger.periodMonth') }))
      expect(screen.queryByText('October rent')).toBeNull() // November holds nothing
      fireEvent.click(screen.getByRole('button', { name: en('ledger.periodPrev') }))
      await screen.findByText('October rent')
      const label = new Date(2025, 9, 1).toLocaleDateString('en', { month: 'long', year: 'numeric' })
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
      await clickExport()
      const d = exported()
      expect(d.items).toHaveLength(4)
      expect(d.period).toBe(label)
      expect(d.filter).toBe('') // the period line already names the window; the filter line does not repeat it
      expect(screen.getByRole('button', { name: en('ledger.periodMonth') }).getAttribute('aria-pressed')).toBe('true')
      // Forward to November, where nothing is: the empty row names the period and offers the way back.
      fireEvent.click(screen.getByRole('button', { name: en('ledger.periodNext') }))
      expect(screen.queryByText('October rent')).toBeNull()
      const novLabel = new Date(2025, 10, 1).toLocaleDateString('en', { month: 'long', year: 'numeric' })
      expect(screen.getByText(en('ledger.emptyPeriod').replace('{period}', novLabel))).toBeTruthy()
      const back = screen.getAllByRole('button', { name: en('ledger.periodAll') })
      fireEvent.click(back[back.length - 1]!) // the way back the empty row offers
      await screen.findByText('October rent')
    } finally {
      vi.useRealTimers()
    }
  })
  it('shows a closed proposal as closed: its own state, no outflow sign, and a filter of its own', async () => {
    const refused = { ...base, id: 'p4', kind: 'payment', state: 'rejected', memo: 'Refused chairs', to_address: 'u1no', value_zat: 75000000, value_zec: '0.75', created_at: 1760100000, approvals: [], refusals: ['Alice', 'Bob'], approvals_count: 0 }
    getLedger.mockResolvedValue([pending, refused, rent])
    mount()
    const cell = await screen.findByText('Refused chairs')
    const row = cell.closest('tr')!
    expect(row.className).toContain('closed')
    expect(row.textContent).toContain(en('ledger.closedNoMoney'))
    expect(row.textContent).not.toContain('−0.75') // money never left: no outflow sign
    fireEvent.click(screen.getByRole('button', { name: en('ledger.filterClosed') }))
    expect(screen.queryByText('October rent')).toBeNull()
    expect(screen.getByText('Refused chairs')).toBeTruthy()
    await clickExport()
    expect(exported().items.map((i) => i.memo)).toEqual(['Refused chairs'])
    expect(exported().filter).toBe(en('ledger.filterClosed'))
  })

  it('the CSV is built in the browser from the same rows as the XLSX, filters included (#301)', async () => {
    mount()
    await screen.findByText('October rent')
    fireEvent.click(screen.getByRole('button', { name: en('ledger.filterPayments') }))
    fireEvent.click(screen.getByRole('button', { name: en('ledger.exportCsv') }))
    await waitFor(() => expect(exportLedgerCsv).toHaveBeenCalled())
    const [d, locale] = exportLedgerCsv.mock.lastCall!
    expect(locale).toBe('en')
    expect(d.items.map((i) => i.memo)).toEqual(['', 'October rent'])
    expect(d.filter).toBe(en('ledger.filterPayments'))
  })

  it('a book that could not be read is said as such, not left on the skeleton forever (#320)', async () => {
    getLedger.mockResolvedValueOnce(null).mockResolvedValue([pending, payroll, rent])
    recordRead('/api/ledger', 'timeout', 'bridge')
    mount()
    await screen.findByText(en('ledger.unreadTitle'))
    expect(screen.getByRole('button', { name: en('ledger.exportXlsx') }).hasAttribute('disabled')).toBe(true) // nothing to export
    expect(screen.queryByText('−0.0000')).toBeNull() // no total is claimed for a book that was not read
    const again = await screen.findByRole('button', { name: en('read.retry') })
    recordRead('/api/ledger', null)
    fireEvent.click(again)
    await screen.findByText('October rent')
  })
})
