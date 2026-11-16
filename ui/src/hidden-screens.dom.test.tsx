// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import type { ReactElement } from 'react'
import { I18nProvider } from './i18n'
import { RevealProvider } from './reveal'
import { zecToUsd } from './price'
import { en as dict } from './i18n/en'
import { ToastProvider } from './toast'

// #838, screen by screen: while amounts are hidden, no figure under a bar is anywhere in the page's
// markup, not as text and not in an attribute (an aria-label is read aloud). The Dashboard's
// composition bar carried the three balance parts in an aria-label that no veil covered.
const getVault = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
const readBalance = vi.hoisted(() => vi.fn())
const readTransactions = vi.hoisted(() => vi.fn())
const getProposalDetail = vi.hoisted(() => vi.fn())
const getBalance = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), getVault, getProposals, getLedger, readBalance, readTransactions, getProposalDetail, getBalance, IS_NET: false,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {}, bg: { seatCount: 2 } }) }))
vi.mock('./toast', async (orig) => ({ ...(await orig<typeof import('./toast')>()), useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: Dashboard } = await import('./screens/Dashboard')
const { default: Ledger } = await import('./screens/Ledger')
const { default: Proposal } = await import('./screens/Proposal')

const ADDR = 'u1' + 'q'.repeat(76)
const base = { vault_id: 'v', proposer: 'Alice', is_public: false, approvals: ['Alice'], refusals: [], approvals_count: 1, created_at: 1759300000 }
// Figures chosen so no one of them is a substring of another or of a fee.
const open = { ...base, id: 'p1', kind: 'payment', state: 'awaiting', memo: 'Rent', to_address: ADDR, value_zat: 123456789, value_zec: '1.23456789' }
const sent = { ...base, id: 'p2', kind: 'payment', state: 'confirmed', memo: 'Fuel', to_address: ADDR, value_zat: 234567891, value_zec: '2.34567891', txid: 'a'.repeat(64) }
// A second month, so the monthly spend chart has two bars to draw (it draws from two).
const sentOld = { ...base, id: 'p4', kind: 'payment', state: 'confirmed', memo: 'Tools', to_address: ADDR, value_zat: 345678912, value_zec: '3.45678912', txid: 'b'.repeat(64), created_at: 1756700000 }
// total 7.77654321, spendable 6, reserved by `open` 1.23456789: free 4.76543211, confirming 1.77654321
const bal = { configured: true, total_zat: 777654321, total_zec: '7.77654321', spendable_zat: 600000000, spendable_zec: '6' }
const FIGURES = ['7.77654321', '4.76543211', '1.77654321', '1.23456789', '2.34567891', '3.45678912']

const shell = (el: ReactElement) => render(
  <MemoryRouter initialEntries={[{ pathname: '/', state: { id: 'p1' } }]}><I18nProvider><ToastProvider>
    <Routes><Route element={<Outlet context={{ locked: false, unlockNonce: 0, live: true }} />}><Route path="/" element={el} /></Route></Routes>
  </ToastProvider></I18nProvider></MemoryRouter>,
)
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 80)) })

describe('hidden, no screen carries a figure in its markup (#838)', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }], group_pubkey: 'v', orchard_address: 'u1x' })
    getProposals.mockResolvedValue([open])
    getLedger.mockResolvedValue([open, sent, sentOld])
    readBalance.mockResolvedValue(bal)
    getBalance.mockResolvedValue(bal)
    readTransactions.mockResolvedValue([])
    getProposalDetail.mockImplementation(async () => ({ proposal: open, lines: [] }))
  })
  afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks() })

  it('the Dashboard, including the composition bar read aloud as one picture', async () => {
    const c = shell(<Dashboard />).container
    await settle()
    expect(c.querySelector('.comp'), 'the composition bar rendered, so the fixture reaches it').not.toBeNull()
    expect(c.querySelector('.secret'), 'and so did the veils').not.toBeNull()
    for (const f of FIGURES) expect(c.innerHTML, f).not.toContain(f)
  })

  it('the Dashboard monthly spend chart (bar titles and its table) draws only once revealed, with a sentence in its place', async () => {
    const c = shell(<Dashboard />).container
    await settle()
    expect(c.querySelector('.spend')).toBeNull()
    expect(c.textContent).toContain(dict['dashboard.spendHidden'])
    cleanup()
    const shown = shell(<RevealProvider initial><Dashboard /></RevealProvider>).container
    await settle()
    expect(shown.querySelector('.spend')).not.toBeNull()
    expect(shown.innerHTML).toContain('2.34567891')
  })

  it('the Dashboard USD estimate of what was paid is under the bar too', async () => {
    localStorage.setItem('konclave.usd.enabled', '1')
    localStorage.setItem('konclave.usd.cache', JSON.stringify({ usd: 123.45, at: Date.now(), source: 'CoinGecko' }))
    const c = shell(<Dashboard />).container
    await settle()
    const paid = zecToUsd(2.34567891 + 3.45678912, { usd: 123.45, at: Date.now(), source: 'CoinGecko' })!
    expect(paid.length).toBeGreaterThan(3)
    expect(c.innerHTML).not.toContain(paid)
    expect(c.querySelector('.kpi-sub .secret')).not.toBeNull()
  })

  it('the Dashboard line without a composition (no zatoshi total) also keeps the confirming amount under the bar', async () => {
    readBalance.mockResolvedValue({ configured: true, total_zec: '7.77654321', spendable_zec: '6', pending_zec: '1.77654321' })
    const c = shell(<Dashboard />).container
    await settle()
    expect(c.querySelector('.comp')).toBeNull()
    expect(c.querySelector('.breakdown .pd .secret')).not.toBeNull()
    expect(c.innerHTML).not.toContain('1.77654321')
  })

  it('the Ledger', async () => {
    const c = shell(<Ledger />).container
    await settle()
    expect(c.querySelector('.secret')).not.toBeNull()
    for (const f of ['1.23456789', '2.34567891']) expect(c.innerHTML, f).not.toContain(f)
  })

  it('a proposal: its amount', async () => {
    const c = shell(<Proposal />).container
    await settle()
    expect(c.querySelector('.p-amt .secret')).not.toBeNull()
    expect(c.innerHTML).not.toContain('1.23456789')
  })
})
