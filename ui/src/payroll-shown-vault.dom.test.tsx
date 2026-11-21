// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'

// The payroll screen is pinned to the vault it opened on: an answer about another vault, which the
// selection moved to while it loaded, is not used for its name or for the proposal it makes.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null }))
const sent = vi.hoisted(() => ({ create: vi.fn(async (..._a: unknown[]) => null) }))
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), createPayroll: sent.create }))
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  actingAs: async () => ({ ok: true, seat: 1, name: 'Ana' }),
  getVault: async () => {
    if (gate.wait) await gate.wait
    const id = localStorage.getItem('konclave.selectedVault') ?? 'X'
    return { id, name: `Treasury ${id}`, threshold: 2, total: 2, member_list: [{ name: 'Ana' }, { name: 'Bia' }] }
  },
  getBeneficiaries: async () => [], getLedger: async () => [], getProposals: async () => [], readBalance: async () => ({ configured: true, total_zat: 100_000_000, spendable_zat: 100_000_000, total_zec: '1', spendable_zec: '1' }), getBalance: async () => null,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./fee-estimate', async (orig) => ({ ...(await orig<typeof import('./fee-estimate')>()), useFeeEstimate: () => ({ state: 'ready', estimate: () => 10000 }) }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))
vi.mock('./device-key', async (orig) => ({ ...(await orig<typeof import('./device-key')>()), signGovernanceWrite: () => ({}) as never }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.stubGlobal('fetch', async (url: string) => (String(url).includes('/api/vault/members') ? new Response(JSON.stringify({ members: ['Ana', 'Bia'] }), { status: 200 }) : new Response('{}', { status: 404 })))
const { unlockSeatForTest } = await import('./acting-test-support')
const { default: NewPayroll } = await import('./screens/NewPayroll')
const tree = () => <MemoryRouter><I18nProvider><NewPayroll /></I18nProvider></MemoryRouter>
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)) })

describe('the payroll screen ignores an answer about another vault', () => {
  beforeEach(() => { localStorage.setItem('konclave.selectedVault', 'X'); localStorage.setItem('konclave.locale', 'en'); gate.wait = null })
  afterEach(() => cleanup())
  it('the pair: an answer about the pinned vault is used', async () => {
    render(tree()); await settle()
    expect(document.body.textContent).toContain('Treasury X')
  })
  it('the selection moved while it loaded: the answer about Y is not used', async () => {
    let release = () => {}
    gate.wait = new Promise<void>((r) => { release = r })
    render(tree())
    localStorage.setItem('konclave.selectedVault', 'Y')
    await act(async () => { release() })
    await settle()
    expect(document.body.textContent).not.toContain('Treasury Y')
  })
  const ADDR = 'u1' + 'q'.repeat(76)
  const fill = async () => {
    fireEvent.change((await screen.findAllByRole('combobox'))[0]!, { target: { value: ADDR } })
    fireEvent.change(screen.getAllByLabelText(en('payroll.colValue'))[0]!, { target: { value: '0.1' } })
    const btn = screen.getByRole('button', { name: en('payroll.submitBtn') }) as HTMLButtonElement
    await waitFor(() => expect(btn.disabled).toBe(false))
    return btn
  }
  it('m11 the pair: with no switch the payroll goes to the pinned vault', async () => {
    sent.create.mockClear(); unlockSeatForTest('X', 1)
    render(tree()); await settle()
    const btn = await fill()
    await act(async () => { fireEvent.click(btn) })
    await waitFor(() => expect(sent.create).toHaveBeenCalledTimes(1))
    expect(sent.create.mock.calls[0]![0]).toMatchObject({ vault: 'X' })
  })
  it('m11 the selection moved after the screen loaded: submitting sends nothing to the other vault', async () => {
    sent.create.mockClear(); unlockSeatForTest('X', 1); unlockSeatForTest('Y', 1) // the device could sign for either; unlockSeatForTest('X', 1)
    render(tree()); await settle()
    const btn = await fill()
    localStorage.setItem('konclave.selectedVault', 'Y')
    await act(async () => { fireEvent.click(btn) })
    await settle()
    expect(sent.create).not.toHaveBeenCalled()
  })
})
