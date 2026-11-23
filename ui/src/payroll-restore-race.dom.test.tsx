// @vitest-environment jsdom
// The bridge has the browser's IndexedDB: an empty vault list, not a broken one.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'

// The draft is restored asynchronously. A member who acts before it arrives must not have the late
// restore replace what they did: the read is held here, the member acts, then the read is released.
const health = vi.hoisted(() => vi.fn())
const getBeneficiaries = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const readBalance = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const gate = vi.hoisted(() => ({ release: (_v: unknown) => {}, promise: Promise.resolve<unknown>(null) }))
vi.mock('./fee-estimate', async (orig) => ({
  ...(await orig<typeof import('./fee-estimate')>()),
  useFeeEstimate: () => ({ state: 'ready', estimate: (d: number) => 5000 * Math.max(3, Math.max(1, d) + 1) }),
}))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health, getBeneficiaries, getLedger, getVault, readBalance, getProposals, IS_NET: false }))
vi.mock('./payroll-draft', async (orig) => ({ ...(await orig<typeof import('./payroll-draft')>()), readPayrollDraft: () => gate.promise }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: NewPayroll } = await import('./screens/NewPayroll')
const { setSelectedVault } = await import('./api')

const OLD = 'u1' + 'o'.repeat(76)
const STORED = { competencia: 'old period', description: 'old text', copiedFrom: null, rows: [{ label: '', address: OLD, value: '9', memo: '' }, { label: '', address: OLD, value: '8', memo: '' }, { label: '', address: OLD, value: '7', memo: '' }] }

const mount = () => render(<MemoryRouter><I18nProvider><NewPayroll /></I18nProvider></MemoryRouter>)
const comp = () => screen.getByPlaceholderText(dict['payroll.competencePlaceholder']!) as HTMLInputElement
const lines = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('.plr-line'))
const settle = () => new Promise((r) => setTimeout(r, 120))

beforeEach(() => {
  localStorage.setItem('konclave.locale', 'en')
  setSelectedVault('v')
  gate.promise = new Promise((res) => { gate.release = res })
  health.mockResolvedValue(true); getBeneficiaries.mockResolvedValue([]); getLedger.mockResolvedValue([]); getProposals.mockResolvedValue([])
  getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Alice' }], group_pubkey: 'v', orchard_address: 'u1x' })
  readBalance.mockResolvedValue({ configured: true, spendable_zat: 500000000, total_zat: 500000000 })
})
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 80)); localStorage.clear() })

describe('a late restore never replaces what the member did meanwhile', () => {
  it('typed text survives', async () => {
    mount()
    await screen.findByRole('button', { name: dict['payroll.addRow']! })
    fireEvent.change(comp(), { target: { value: 'my period' } })
    gate.release(STORED)
    await settle()
    expect(comp().value).toBe('my period')
  })

  it('an added row survives, and the stored rows do not replace it', async () => {
    const { container: c } = mount()
    await screen.findByRole('button', { name: dict['payroll.addRow']! })
    fireEvent.click(screen.getByRole('button', { name: dict['payroll.addRow']! }))
    const before = lines(c).length
    gate.release(STORED)
    await settle()
    expect(lines(c).length).toBe(before)
  })

  it('a member who did nothing still gets the stored draft', async () => {
    const { container: c } = mount()
    await screen.findByRole('button', { name: dict['payroll.addRow']! })
    gate.release(STORED)
    await waitFor(() => expect(comp().value).toBe('old period'))
    expect(lines(c).length).toBe(3)
  })

  it('what the member did is what is saved afterwards, not the older draft', async () => {
    mount()
    await screen.findByRole('button', { name: dict['payroll.addRow']! })
    fireEvent.change(comp(), { target: { value: 'my period' } })
    gate.release(STORED)
    await settle()
    await waitFor(() => expect(JSON.parse(localStorage.getItem('konclave.folha.rascunho.v') ?? 'null')?.competencia).toBe('my period'))
  })
})
