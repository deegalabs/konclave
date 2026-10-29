// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { explorerTxUrl, fmtDate } from './format'
import type { LedgerXlsxData } from './ledgerXlsx'
const en = (k: string): string => dict[k] ?? k

// #302: the XLSX export iterated every row in memory, so a book filtered on screen exported
// everything, silently, and no row carried its txid or memo. This mounts the real screen in a
// simulated browser over a fake book, sets the filters a treasurer would, clicks Export, and reads
// what the export was handed.
const exportLedgerXlsx = vi.hoisted(() => vi.fn<(d: LedgerXlsxData) => Promise<void>>(async () => {}))
vi.mock('./ledgerXlsx', async (orig) => ({ ...(await orig<typeof import('./ledgerXlsx')>()), exportLedgerXlsx }))
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

  it('links a settled row to the same explorer page the export does', async () => {
    mount()
    await screen.findByText('October rent')
    const link = screen.getByRole('link', { name: `${en('state.confirmed')} ↗` })
    expect(link.getAttribute('href')).toBe(explorerTxUrl(TX1))
  })
})
