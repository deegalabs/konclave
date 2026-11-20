// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { en as dict } from './i18n/en'
import type { FeeEstimator } from './fee-estimate'
import type { Proposal } from './api'

// #1017: the Dashboard's "Reserved" summed only each open proposal's value and left out its network
// fee, so Free read higher than what could really be paid. It now asks the ONE function the payment
// screens use, and an unread list is "-", not "nothing is held".
localStorage.setItem('konclave.locale', 'en')
// An injected estimator with a per-destination part: no number of the real rule is typed here.
// Revealed on purpose (#838): hidden, the figures are not in the markup, and this reads them.
const est: FeeEstimator = (n) => 1_000 * (n + 3)
const fee = vi.hoisted(() => ({ state: 'ready' as 'ready' | 'unavailable' | 'loading' }))
vi.mock('./fee-estimate', async (orig) => ({
  ...(await orig<typeof import('./fee-estimate')>()),
  useFeeEstimate: () => (fee.state === 'ready' ? { state: 'ready', estimate: (n: number) => 1_000 * (n + 3) } : { state: fee.state }),
}))
const reads = vi.hoisted(() => ({ proposals: null as unknown }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  getVault: async () => ({ id: 'v', name: 'Vault', threshold: 2, total: 2, member_list: [], locked: false }),
  getProposals: async () => reads.proposals,
  getLedger: async () => [],
  readBalance: async () => ({ configured: true, total_zat: 1_000_000, total_zec: '0.01', spendable_zat: 1_000_000, spendable_zec: '0.01' }),
  readTransactions: async () => [],
  getSelectedVault: () => 'v',
  isVaultUnlocked: () => true,
}))
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: vi.fn() }) }))
vi.mock('./seat-registration', async (orig) => ({
  ...(await orig<typeof import('./seat-registration')>()),
  useSeatRefusal: () => null,
  useSeatRefusalCode: () => undefined,
}))
const { default: Dashboard } = await import('./screens/Dashboard')
const { I18nProvider } = await import('./i18n')
const { RevealProvider } = await import('./reveal')
const { fmtZecExact } = await import('./format')

const open = (over: Partial<Proposal>): Proposal => ({
  id: 'p1', vault_id: 'v', kind: 'payment', state: 'awaiting', proposer: 'Ana', value_zat: 10_000, value_zec: '0.0001',
  is_public: false, approvals: [], refusals: [], approvals_count: 0, created_at: Math.floor(Date.now() / 1000),
  expiry_unix: Math.floor(Date.now() / 1000) + 3600, destinations: 1, ...over,
})

function show() {
  return render(
    <MemoryRouter>
      <I18nProvider><RevealProvider initial>
        <Routes>
          <Route element={<OutletWith />}><Route index element={<Dashboard />} /></Route>
        </Routes>
      </RevealProvider></I18nProvider>
    </MemoryRouter>,
  )
}
import { Outlet } from 'react-router-dom'
function OutletWith() {
  return <Outlet context={{ locked: false, unlockNonce: 0, live: true }} />
}
const kpiReserved = () => [...document.querySelectorAll('.kpi-k')].find((e) => e.textContent === dict['dashboard.kpiReserved'])!.closest('.kpi')!.textContent!
const readyFree = () => document.querySelector('.ready')!.textContent!

describe('the Dashboard Reserved and Free count the fee (#1017)', () => {
  beforeEach(() => { fee.state = 'ready' })
  afterEach(() => cleanup())

  it('an open N-line payroll holds its value plus the estimate for N, and Free is spendable minus it', async () => {
    reads.proposals = [open({ kind: 'payroll', value_zat: 10_000, destinations: 3 })]
    show()
    const held = 10_000 + est(3)!
    await waitFor(() => expect(kpiReserved()).toContain(fmtZecExact(held / 1e8)))
    expect(readyFree()).toContain(fmtZecExact((1_000_000 - held) / 1e8))
  })

  it('a list that could not be read shows "-", and does not read as "no free funds"', async () => {
    reads.proposals = null
    show()
    await waitFor(() => expect(kpiReserved()).toContain('-'))
    expect(kpiReserved()).not.toContain('0.00000000')
    expect(readyFree()).not.toContain(dict['dashboard.readyNoFree']!)
    expect(readyFree()).toContain(dict['dashboard.readyFreeUnknown']!)
  })

  it('with no open proposal Reserved is 0 even when the estimate is unavailable', async () => {
    fee.state = 'unavailable'
    reads.proposals = []
    show()
    await waitFor(() => expect(kpiReserved()).toContain(fmtZecExact(0)))
    expect(readyFree()).toContain(fmtZecExact(1_000_000 / 1e8))
  })

  it('with an open proposal and no estimate it is "-", never the value alone', async () => {
    fee.state = 'unavailable'
    reads.proposals = [open({})]
    show()
    await waitFor(() => expect(kpiReserved()).toContain('-'))
    expect(kpiReserved()).not.toContain(fmtZecExact(10_000 / 1e8))
  })
})
