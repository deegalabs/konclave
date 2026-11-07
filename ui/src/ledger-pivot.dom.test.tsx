// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string, v: Record<string, string> = {}): string =>
  Object.entries(v).reduce((s, [key, val]) => s.replaceAll(`{${key}}`, val), dict[k] ?? k)

// #778: the book by beneficiary, rendered by the real screen over a fake book. What the member reads
// is checked with literal values: the sums match, a payroll whose lines could not be read is named
// with its count, and a view where every payroll is unreadable says so instead of "nothing settled".
const getLedger = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getProposalDetail = vi.hoisted(() => vi.fn())
const getBeneficiaries = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), getLedger, getVault, getProposalDetail, getBeneficiaries, ledgerCsvUrl: () => '#', IS_NET: false,
}))

const { default: Ledger } = await import('./screens/Ledger')

const base = { vault_id: 'v', proposer: 'Alice', is_public: false, approvals: ['Alice', 'Bob'], refusals: [], approvals_count: 2 }
// 1.50000001 ZEC: a figure that four decimals would print as 1.5000, so the exact format is visible.
const rent = { ...base, id: 'p1', kind: 'payment', state: 'confirmed', memo: 'October rent', to_address: 'u1rent', value_zat: 150000001, value_zec: '1.50000001', created_at: 1759300000 }
const pending = { ...base, id: 'p2', kind: 'payment', state: 'awaiting', memo: '', to_address: 'u1open', value_zat: 25000000, value_zec: '0.25', created_at: 1760000000 }
const payroll = { ...base, id: 'p3', kind: 'payroll', state: 'sent', memo: 'Payroll October', value_zat: 200000000, value_zec: '2', created_at: 1759500000 }
const payroll2 = { ...base, id: 'p5', kind: 'payroll', state: 'awaiting', memo: 'Payroll November', value_zat: 30000000, value_zec: '0.3', created_at: 1759600000 }
const refused = { ...base, id: 'p6', kind: 'payroll', state: 'refused', memo: 'Payroll refused', value_zat: 90000000, value_zec: '0.9', created_at: 1759700000 }
const line = (label: string, address: string, value_zat: number) => ({ label, address, value_zat, value_zec: '', memo: '', is_public: false })
const lines: Record<string, ReturnType<typeof line>[]> = {
  p3: [line('Alice', 'u1alice', 120000000), line('Bob', 'u1bob', 80000000)],
  p5: [line('Carla', 'u1carla', 30000000)],
}

const mount = () => render(<MemoryRouter><I18nProvider><Ledger /></I18nProvider></MemoryRouter>)
const openPivot = async () => {
  await screen.findByText(/Payroll/)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(en('ledger.byPayee')) }))
}
const status = () => document.querySelector('.pivot-check') as HTMLElement

describe('the book by beneficiary, as the member reads it (#778)', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: 'v', orchard_address: 'u1x' })
    getBeneficiaries.mockResolvedValue([])
    getProposalDetail.mockImplementation(async (id: string) => (lines[id] ? { proposal: {}, lines: lines[id] } : null))
  })
  afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })

  it('says the sums match, and prints every figure to the zatoshi', async () => {
    getLedger.mockResolvedValue([pending, payroll, rent])
    mount()
    await openPivot()
    await waitFor(() => expect(status().textContent).toBe(en('ledger.pivotMatches')))
    const foot = document.querySelector('.pivot-tbl tfoot') as HTMLElement
    expect(foot.textContent).toBe(`${en('ledger.total')}3.500000010.25004`)
    expect(document.querySelector('.pivot-tbl tbody')?.textContent).toContain('1.50000001')
  })

  it('names a payroll whose lines could not be read, with its count and the difference under the bar', async () => {
    getLedger.mockResolvedValue([pending, payroll, rent, refused])
    getProposalDetail.mockResolvedValue(null)
    mount()
    await openPivot()
    // The refused payroll is unreadable too, but it counts in neither total, so it is not in the count.
    await waitFor(() => expect(status().textContent).toBe(en('ledger.pivotMismatch', { diff: '2.0000', n: '1' })))
    const veiled = status().querySelector('.secret')
    expect(veiled?.textContent).toBe('2.0000')
  })

  it('does not say "nothing settled" when every payroll in view is unreadable and the book has a total', async () => {
    getLedger.mockResolvedValue([payroll])
    getProposalDetail.mockResolvedValue(null)
    mount()
    await openPivot()
    await waitFor(() => expect(status().textContent).toBe(en('ledger.pivotMismatch', { diff: '2.0000', n: '1' })))
    expect(status().textContent).not.toBe(en('ledger.pivotEmpty'))
  })

  it('says it when the view really is empty', async () => {
    getLedger.mockResolvedValue([refused])
    mount()
    await openPivot()
    await waitFor(() => expect(status().textContent).toBe(en('ledger.pivotEmpty')))
  })

  it('finishes reading the lines when the screen re-renders its scope mid-read', async () => {
    // A re-run of the read (a poll, a filter) used to drop the answer in flight, never reset the
    // "reading" line and never ask for the ids still queued.
    getLedger.mockResolvedValue([payroll, payroll2])
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    getProposalDetail.mockImplementation(async (id: string) => {
      if (id === 'p3') await gate
      return { proposal: {}, lines: lines[id] }
    })
    mount()
    await openPivot()
    await waitFor(() => expect(status().textContent).toBe(en('ledger.pivotLoading')))
    fireEvent.click(screen.getByRole('button', { name: en('ledger.filterPayrolls') }))
    release()
    await waitFor(() => expect(status().textContent).toBe(en('ledger.pivotMatches')))
    expect(getProposalDetail.mock.calls.map((c) => c[0]).sort()).toEqual(['p3', 'p5'])
  })

  it('reads the registry once per opening, not on every re-read of the book', async () => {
    getLedger.mockResolvedValue([pending, payroll, rent])
    mount()
    await openPivot()
    await waitFor(() => expect(status().textContent).toBe(en('ledger.pivotMatches')))
    fireEvent.click(screen.getByRole('button', { name: en('ledger.filterPayrolls') }))
    fireEvent.click(screen.getByRole('button', { name: en('ledger.filterPayments') }))
    expect(getBeneficiaries).toHaveBeenCalledTimes(1)
  })
})
