// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #949, at the level of the screen: the real Ledger over the real readers, a fetch that answers and is
// counted. On the web, opening the book by beneficiary and exporting each read the vault's proposals
// ONCE, however many payrolls; on the local bridge each payroll is read by id, past the comparison's cap.

const VAULT = 'ab'.repeat(32)
const N = 20
const U = (i: number) => 'u1' + String(i).padStart(2, '0').repeat(38)
const netRow = (i: number) => ({
  id: `r${i}`, vault_id: VAULT, kind: 'payroll', to: '', amount_zat: 10, proposer: 'Ana', state: 'sent',
  approvals: ['Ana'], refusals: [], threshold: 1, total: 1, created_at_unix: 1759000000 + i, expiry_unix: 0, memo: `Payroll ${i}`,
  lines: [{ label: `P${i}`, to: U(i), amount_zat: 10 }],
})
const bridgeRow = (i: number) => ({
  id: `b${i}`, vault_id: 'v', kind: 'payroll', state: 'sent', memo: `Payroll ${i}`, proposer: 'Ana', is_public: false,
  approvals: ['Ana'], refusals: [], approvals_count: 1, value_zat: 10, value_zec: '0.0000001', created_at: 1759000000 + i,
})

type Mode = 'web' | 'bridge'
async function setup(mode: Mode) {
  if (mode === 'web') { vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example'); localStorage.setItem('konclave.selectedVault', VAULT) }
  else vi.stubEnv('VITE_HELPER_BASE', '')
  localStorage.setItem('konclave.locale', 'en')
  vi.resetModules()
  const exportLedgerXlsx = vi.fn(async () => {})
  vi.doMock('./ledgerXlsx', async (orig) => ({ ...(await orig<typeof import('./ledgerXlsx')>()), exportLedgerXlsx }))
  const urls: string[] = []
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
    const url = String(u)
    urls.push(url)
    if (url.includes('/api/vault/proposals')) return json({ proposals: Array.from({ length: N }, (_, i) => netRow(i)) })
    if (url.includes('/api/ledger')) return json({ ledger: Array.from({ length: N }, (_, i) => bridgeRow(i)) })
    const m = url.match(/\/api\/proposals\/([^?]+)/)
    if (m) { const id = decodeURIComponent(m[1]!); return json({ proposal: { id, kind: 'payroll' }, lines: [{ label: id, address: U(1), value_zat: 10, value_zec: '', memo: '', is_public: false }] }) }
    return new Response('{}', { status: 404 })
  }))
  const { I18nProvider } = await import('./i18n')
  const { default: Ledger } = await import('./screens/Ledger')
  render(<MemoryRouter><I18nProvider><Ledger /></I18nProvider></MemoryRouter>)
  await screen.findByText('Payroll 3')
  const book = () => urls.filter((u) => u.includes('/api/vault/proposals')).length
  const details = () => urls.filter((u) => /\/api\/proposals\//.test(u)).length
  return { exportLedgerXlsx, book, details, urls }
}

describe('the Ledger reads payroll lines once per action on the web, per payroll on the bridge (#949)', () => {
  afterEach(() => { cleanup(); vi.doUnmock('./ledgerXlsx'); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear() })

  it('web: the book by beneficiary is one read of the proposals', async () => {
    const s = await setup('web')
    const before = s.book()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en('ledger.byPayee')) }))
    await waitFor(() => expect((document.querySelector('.pivot-check') as HTMLElement | null)?.textContent).toBe(en('ledger.pivotMatches')))
    expect(before).toBe(1)
    expect(s.book() - before).toBe(1)
  })

  it('web: exporting is one read of the proposals', async () => {
    const s = await setup('web')
    const before = s.book()
    fireEvent.click(screen.getByRole('button', { name: en('ledger.exportXlsx') }))
    await waitFor(() => expect(s.exportLedgerXlsx).toHaveBeenCalled())
    const d = (s.exportLedgerXlsx.mock.lastCall as unknown as [{ items: unknown[] }])[0]
    expect(before).toBe(1)
    expect(s.book() - before).toBe(1)
    expect(d.items).toHaveLength(N)
  })

  it('bridge: the book by beneficiary and the export each read every payroll by id, past the cap', async () => {
    const { BRIDGE_PAYROLLS_READ } = await import('./api')
    expect(N).toBeGreaterThan(BRIDGE_PAYROLLS_READ)
    const s = await setup('bridge')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en('ledger.byPayee')) }))
    await waitFor(() => expect((document.querySelector('.pivot-check') as HTMLElement | null)?.textContent).toBe(en('ledger.pivotMatches')))
    expect(s.details()).toBe(N)
    cleanup()
    const t = await setup('bridge')
    fireEvent.click(screen.getByRole('button', { name: en('ledger.exportXlsx') }))
    await waitFor(() => expect(t.exportLedgerXlsx).toHaveBeenCalled())
    const d = (t.exportLedgerXlsx.mock.lastCall as unknown as [{ items: unknown[] }])[0]
    expect(t.details()).toBe(N)
    expect(d.items).toHaveLength(N)
  })
  it('web: one payroll row opened shows its own lines, from one read; then the pivot and the export add one and none', async () => {
    const s = await setup('web')
    fireEvent.click(screen.getByText('Payroll 3'))
    await screen.findByText((_, el) => el?.tagName === 'TD' && /^↳ P3/.test(el.textContent ?? ''))
    const afterRow = s.book()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(en('ledger.byPayee')) }))
    await waitFor(() => expect((document.querySelector('.pivot-check') as HTMLElement | null)?.textContent).toBe(en('ledger.pivotMatches')))
    const afterPivot = s.book()
    fireEvent.click(screen.getByRole('button', { name: en('ledger.exportXlsx') }))
    await waitFor(() => expect(s.exportLedgerXlsx).toHaveBeenCalled())
    expect([afterRow, afterPivot, s.book()]).toEqual([2, 3, 3])
  })
})
