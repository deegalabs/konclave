// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #591: the proposing screens say WHO proposes from `actingAs` (the seat's name, as the coordinator
// serves it), keep Propose closed when that is unknown and say what is needed, and show the roster
// warning (protocol 3) without blocking. No "Alice" default.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.locale', 'en')
const ctl = vi.hoisted(() => ({
  acting: { ok: true, seat: 2, name: 'Bia' } as { ok: boolean; seat?: number; name?: string; why?: string },
  vault: {} as Record<string, unknown>,
}))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Vault', threshold: 2, total: 2, member_list: [{ name: 'Ana', pubkey: 'Ana' }, { name: 'Bia', pubkey: 'Bia' }], ...ctl.vault }),
  actingAs: async () => ctl.acting,
  getBeneficiaries: async () => [],
  getProposals: async () => [],
  getLedger: async () => [],
  createProposal: vi.fn(),
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
const { default: NewPayment } = await import('./screens/NewPayment')
const { default: NewPayroll } = await import('./screens/NewPayroll')
const { I18nProvider } = await import('./i18n')
const { ToastProvider } = await import('./toast')
const shell = (c: React.ReactNode) => <MemoryRouter><I18nProvider><ToastProvider>{c}</ToastProvider></I18nProvider></MemoryRouter>

async function fillPayment() {
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: U } })
  fireEvent.click(screen.getByRole('option'))
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0.01' } })
}
const propose = () => screen.getByRole('button', { name: en('payment.proposeBtn') }) as HTMLButtonElement

describe('the payment screen proposes as the seat (#591)', () => {
  afterEach(() => { cleanup(); ctl.vault = {}; ctl.acting = { ok: true, seat: 2, name: 'Bia' } })

  it('names the seat\'s member, and Propose is open', async () => {
    render(shell(<NewPayment />))
    await fillPayment()
    expect((await screen.findAllByText('Bia')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Alice')).toBeNull()
    expect(propose().disabled).toBe(false)
  })

  it.each([
    ['locked', 'actingLocked'],
    ['list-unread', 'actingListUnread'],
    ['no-seat-name', 'actingNoSeatName'],
  ])('%s: Propose stays closed and the reason is said', async (why, key) => {
    ctl.acting = { ok: false, why }
    render(shell(<NewPayment />))
    await fillPayment()
    expect(await screen.findByText(en(`payment.${key}`))).toBeTruthy()
    expect(screen.queryByText('Alice')).toBeNull()
    expect(propose().disabled).toBe(true)
  })

  it('shows the roster warning when this device names the seat differently, and does not block', async () => {
    ctl.vault = { roster_differs: true, own_members: ['Ana', 'Beatriz'] }
    render(shell(<NewPayment />))
    await fillPayment()
    expect(await screen.findByText(en('members.rosterDiffers'))).toBeTruthy()
    expect(propose().disabled).toBe(false)
  })

  it('no warning when this device names the seat the same way', async () => {
    ctl.vault = { roster_differs: true, own_members: ['Ana', 'Bia'] }
    render(shell(<NewPayment />))
    await fillPayment()
    await screen.findAllByText('Bia')
    expect(screen.queryByText(en('members.rosterDiffers'))).toBeNull()
  })
})

describe('the payroll screen proposes as the seat (#591)', () => {
  afterEach(() => { cleanup(); ctl.vault = {}; ctl.acting = { ok: true, seat: 2, name: 'Bia' } })

  it('names the seat\'s member', async () => {
    render(shell(<NewPayroll />))
    expect((await screen.findAllByText('Bia')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Alice')).toBeNull()
  })

  it('locked: the reason is said, no member is named, and submit is closed', async () => {
    ctl.acting = { ok: false, why: 'locked' }
    render(shell(<NewPayroll />))
    expect(await screen.findByText(en('payment.actingLocked'))).toBeTruthy()
    expect(screen.queryByText('Alice')).toBeNull()
    expect((screen.getByRole('button', { name: en('payroll.submitBtn') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the roster warning without blocking', async () => {
    ctl.vault = { roster_differs: true, own_members: ['Ana', 'Beatriz'] }
    render(shell(<NewPayroll />))
    expect(await screen.findByText(en('members.rosterDiffers'))).toBeTruthy()
  })
})
