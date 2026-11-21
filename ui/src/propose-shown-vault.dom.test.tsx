// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// T5: the payment screen shows vault X; another tab selects Y; Propose sends nothing and says why.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.locale', 'en')
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'X', name: 'Vault', threshold: 2, total: 2, member_list: [{ name: 'Ana', pubkey: 'Ana' }, { name: 'Bia', pubkey: 'Bia' }] }),
  actingAs: async () => ({ ok: true, seat: 2, name: 'Bia' }),
  getBeneficiaries: async () => [],
  getProposals: async () => [],
  getLedger: async () => [],
}))
vi.mock('./fee-estimate', async (orig) => ({
  ...(await orig<typeof import('./fee-estimate')>()),
  useFeeEstimate: () => ({ state: 'ready', estimate: (d: number) => 5000 * Math.max(3, Math.max(1, d) + 1) }),
}))
vi.mock('./useVaultBalance', async (orig) => ({
  ...(await orig<typeof import('./useVaultBalance')>()),
  useVaultBalance: () => ({ bal: { total_zat: 100_000_000, spendable_zat: 100_000_000 }, busy: false }),
}))
const U = 'u1' + 'q'.repeat(76)
const sent: string[] = []
const bodies: Record<string, unknown>[] = []
vi.mock('./device-key', async (orig) => ({ ...(await orig<typeof import('./device-key')>()), signGovernanceWrite: () => ({}) as never }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
const made = { id: 'p1', vault_id: 'X', kind: 'payment', to: 'u1x', amount_zat: 1, memo: null, proposer: 'Bia', state: 'pending', approvals: ['Bia'], refusals: [], threshold: 2, total: 2, created_at_unix: 1, expiry_unix: 0, txid: null }
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  sent.push(String(url))
  if (init?.body) { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify(made), { status: 200 }) }
  if (String(url).includes('/api/vault/members')) return new Response(JSON.stringify({ members: ['Ana', 'Bia'] }), { status: 200 })
  return new Response('{}', { status: 404 })
})
const { unlockSeatForTest } = await import('./acting-test-support')
const { default: NewPayment } = await import('./screens/NewPayment')
const { I18nProvider } = await import('./i18n')
const { ToastProvider } = await import('./toast')

async function fill() {
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: U } })
  fireEvent.click(screen.getByRole('option'))
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0.01' } })
  const btn = screen.getByRole('button', { name: en('payment.proposeBtn') }) as HTMLButtonElement
  await vi.waitFor(() => expect(btn.disabled).toBe(false))
  return btn
}

describe('the payment screen does not send to a vault it no longer shows (T5)', () => {
  afterEach(() => { cleanup(); bodies.length = 0 })

  it('the pair: with no switch it sends exactly one POST, to the vault it shows', async () => {
    localStorage.setItem('konclave.selectedVault', 'X')
    unlockSeatForTest('X', 2)
    render(<MemoryRouter><I18nProvider><ToastProvider><NewPayment /></ToastProvider></I18nProvider></MemoryRouter>)
    const btn = await fill()
    fireEvent.click(btn)
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toMatchObject({ vault: 'X', proposer: 'Bia' })
  })

  it('another tab left no vault open: it says so, not that another was opened', async () => {
    localStorage.setItem('konclave.selectedVault', 'X')
    render(<MemoryRouter><I18nProvider><ToastProvider><NewPayment /></ToastProvider></I18nProvider></MemoryRouter>)
    const btn = await fill()
    sent.length = 0
    localStorage.removeItem('konclave.selectedVault')
    fireEvent.click(btn)
    expect((await screen.findAllByText(en('payment.vaultGone'))).length).toBeGreaterThan(0)
    expect(screen.queryByText(en('payment.vaultChanged'))).toBeNull()
    expect(bodies).toHaveLength(0)
  })

  it('says the vault changed and sends nothing', async () => {
    localStorage.setItem('konclave.selectedVault', 'X')
    render(<MemoryRouter><I18nProvider><ToastProvider><NewPayment /></ToastProvider></I18nProvider></MemoryRouter>)
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: U } })
    fireEvent.click(screen.getByRole('option'))
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0.01' } })
    const btn = screen.getByRole('button', { name: en('payment.proposeBtn') }) as HTMLButtonElement
    await vi.waitFor(() => expect(btn.disabled).toBe(false))
    sent.length = 0
    localStorage.setItem('konclave.selectedVault', 'Y') // another tab
    fireEvent.click(btn)
    expect((await screen.findAllByText(en('payment.vaultChanged'))).length).toBeGreaterThan(0)
    expect(sent.filter((u) => u.includes('/api/vault/proposals'))).toEqual([])
  })
})
