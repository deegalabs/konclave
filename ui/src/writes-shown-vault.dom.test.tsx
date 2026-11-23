// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// Adding a payee, voting and renaming act on the vault the screen SHOWS. Another tab moves the
// selection (X shown, Y selected); nothing is written for Y, and the screen says why.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.locale', 'en')
const spies = vi.hoisted(() => ({
  update: vi.fn(async (..._a: unknown[]) => 'written' as const),
  vote: vi.fn(async (..._a: unknown[]) => null),
  rename: vi.fn(async (..._a: unknown[]) => ({ error: 'x' })),
  gate: { wait: null as Promise<void> | null },
}))
vi.mock('./vault-local', async (orig) => ({
  ...(await orig<typeof import('./vault-local')>()),
  readLocal: async () => ({ s: 'absent' as const }),
  updateLocal: spies.update,
}))
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), voteProposal: spies.vote, renameMember: spies.rename }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => {
    if (spies.gate.wait) await spies.gate.wait
    const id = localStorage.getItem('konclave.selectedVault') ?? 'X'
    return { id, name: `Treasury ${id}`, threshold: 2, total: 2, member_list: [{ name: 'Ana', pubkey: 'a' }, { name: 'Bia', pubkey: 'b' }] }
  },
  getProposals: async () => [],
  getLedger: async () => [],
  getBalance: async () => null,
  readTransactions: async () => [],
  getProposalDetail: async () => ({ proposal: { id: 'p1', vault_id: 'X', proposer: 'Bia', is_public: false, approvals: ['Bia'], refusals: [], approvals_count: 1, stances: [{ seat: 2, name: 'Bia', stance: 'approved', counted: true }, { seat: 1, name: 'Ana', stance: 'none', counted: false }], state: 'awaiting', kind: 'payment', to_address: 'u1payee', value_zat: 5000, value_zec: '0.00005' }, lines: [] }),
}))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => ['X', 'Y'].map((id) => ({ id, name: `Treasury ${id}`, governance: id === 'Y' ? 'quorum' : 'open', myName: 'Ana', groupKey: id.toLowerCase().repeat(32), roster: ['Ana', 'Bia'], secured: false })),
}))
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./fee-estimate', async (orig) => ({ ...(await orig<typeof import('./fee-estimate')>()), useFeeEstimate: () => ({ state: 'ready', estimate: () => 10000 }) }))
vi.mock('./useVaultBalance', async (orig) => ({ ...(await orig<typeof import('./useVaultBalance')>()), useVaultBalance: () => ({ bal: null, busy: false }) }))
const { I18nProvider } = await import('./i18n')
const { ToastProvider } = await import('./toast')
const { default: People } = await import('./screens/People')
const { default: Proposal } = await import('./screens/Proposal')
const { default: Members } = await import('./screens/Members')
const { default: NewPayment } = await import('./screens/NewPayment')

const SEL = 'konclave.selectedVault'
const wrap = (el: React.ReactNode, state?: unknown) => (
  <MemoryRouter initialEntries={[{ pathname: '/x', state }]}><I18nProvider><ToastProvider>{el}</ToastProvider></I18nProvider></MemoryRouter>
)
beforeEach(() => { localStorage.setItem(SEL, 'X'); Object.values(spies).forEach((s) => typeof s === 'function' && (s as ReturnType<typeof vi.fn>).mockClear()); spies.gate.wait = null })
afterEach(() => cleanup())

describe('writes name the vault the screen shows', () => {
  it('a: adding a person after the selection moved writes nothing, and says why', async () => {
    render(wrap(<People />))
    fireEvent.change(await screen.findByLabelText(en('people.name')), { target: { value: 'Teo' } })
    fireEvent.change(screen.getByLabelText(en('people.address')), { target: { value: 'u1' + 'q'.repeat(76) } })
    localStorage.setItem(SEL, 'Y')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('people.savePerson') })) })
    expect(spies.update).not.toHaveBeenCalled()
    expect(await screen.findByText(en('settings.vaultChanged'))).toBeTruthy()
  })

  it('m9 a person is added to the pinned vault even when the first answer is about another', async () => {
    let release = () => {}
    spies.gate.wait = new Promise<void>((r) => { release = r })
    render(wrap(<People />))
    localStorage.setItem(SEL, 'Y')
    await act(async () => { release() })
    fireEvent.change(await screen.findByLabelText(en('people.name')), { target: { value: 'Teo' } })
    fireEvent.change(screen.getByLabelText(en('people.address')), { target: { value: 'u1' + 'q'.repeat(76) } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('people.savePerson') })) })
    expect(spies.update).not.toHaveBeenCalled()
  })

  it('m9 the governance notice follows the pinned vault, not an answer about another', async () => {
    localStorage.setItem(SEL, 'Y')
    const first = render(wrap(<People />))
    expect(await screen.findByText(en('gov.nudgeBeneficiaries'))).toBeTruthy() // the pair: Y is a quorum vault
    first.unmount()
    localStorage.setItem(SEL, 'X')
    let release = () => {}
    spies.gate.wait = new Promise<void>((r) => { release = r })
    render(wrap(<People />))
    localStorage.setItem(SEL, 'Y')
    await act(async () => { release() })
    await new Promise((r) => setTimeout(r, 60))
    expect(screen.queryByText(en('gov.nudgeBeneficiaries'))).toBeNull() // X is open; the answer about Y is not used
  })

  it('gone: with no vault open the person is not added, and it says so', async () => {
    render(wrap(<People />))
    fireEvent.change(await screen.findByLabelText(en('people.name')), { target: { value: 'Teo' } })
    fireEvent.change(screen.getByLabelText(en('people.address')), { target: { value: 'u1' + 'q'.repeat(76) } })
    localStorage.removeItem(SEL)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('people.savePerson') })) })
    expect(spies.update).not.toHaveBeenCalled()
    expect(await screen.findByText(en('settings.vaultGone'))).toBeTruthy()
  })

  it('b: a vote after the selection moved sends nothing', async () => {
    render(wrap(<Proposal />, { id: 'p1' }))
    const btn = await screen.findByRole('button', { name: new RegExp(en('proposal.approve'), 'i') })
    localStorage.setItem(SEL, 'Y')
    await act(async () => { fireEvent.click(btn) })
    expect(spies.vote).not.toHaveBeenCalled()
  })

  it('b pair: with no switch the same click sends the vote', async () => {
    render(wrap(<Proposal />, { id: 'p1' }))
    const btn = await screen.findByRole('button', { name: new RegExp(en('proposal.approve'), 'i') })
    await act(async () => { fireEvent.click(btn) })
    expect(spies.vote).toHaveBeenCalledTimes(1)
  })

  it('c: a rename after the selection moved sends nothing', async () => {
    render(wrap(<Members />))
    const input = await screen.findByPlaceholderText('Ana')
    fireEvent.change(input, { target: { value: 'Ana B' } })
    localStorage.setItem(SEL, 'Y')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('members.yourNameSave') })) })
    expect(spies.rename).not.toHaveBeenCalled()
  })

  it('c pair: with no switch the same click sends the rename', async () => {
    render(wrap(<Members />))
    fireEvent.change(await screen.findByPlaceholderText('Ana'), { target: { value: 'Ana B' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('members.yourNameSave') })) })
    expect(spies.rename).toHaveBeenCalledTimes(1)
  })

  it('d: the payment screen ignores an answer about another vault', async () => {
    let release = () => {}
    spies.gate.wait = new Promise<void>((r) => { release = r })
    render(wrap(<NewPayment />))
    localStorage.setItem(SEL, 'Y')
    await act(async () => { release(); await Promise.resolve() })
    await new Promise((r) => setTimeout(r, 50))
    expect(document.body.textContent).not.toContain('Treasury Y')
  })
})
