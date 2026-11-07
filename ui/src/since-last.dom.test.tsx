// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import type { Proposal } from './api'
const en = (k: string, v: Record<string, string> = {}): string =>
  Object.entries(v).reduce((s, [key, val]) => s.replaceAll(`{${key}}`, val), dict[k] ?? k)

// "What changed" (#151, #125), rendered by the real screen: the snapshot is kept per vault on this
// device, a first look says there is nothing to compare, a change that arrives on a later read is
// shown before it can be marked, and marking writes this vault's snapshot and nobody else's.
const getProposals = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getSelectedVault = vi.hoisted(() => vi.fn())
const listVaults = vi.hoisted(() => vi.fn())
const poll = vi.hoisted(() => ({ fn: null as null | (() => void) }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getProposals, getVault, getSelectedVault }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults }))
vi.mock('./usePoll', () => ({ startVisiblePoll: (fn: () => void) => { poll.fn = fn; return () => {} } }))

const { default: SinceLast } = await import('./screens/SinceLast')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const p = (id: string, state: string, over: Partial<Proposal> = {}): Proposal => ({
  id, vault_id: A, kind: 'payment', state, proposer: 'Bia', memo: `Rent ${id}`, value_zat: 150000000, value_zec: '1.5',
  is_public: false, approvals: [], refusals: [], approvals_count: 0, ...over,
})
const mount = () => render(
  <MemoryRouter initialEntries={['/activity']}>
    <I18nProvider>
      <Routes>
        <Route path="/activity" element={<SinceLast />} />
        <Route path="/proposal" element={<p>PROPOSAL PAGE</p>} />
      </Routes>
    </I18nProvider>
  </MemoryRouter>,
)
const tick = async () => { await act(async () => { poll.fn?.(); await Promise.resolve() }) }
const markBtn = () => screen.getByRole('button', { name: en('since.markSeen') })
const seenOf = (id: string) => JSON.parse(localStorage.getItem(`konclave.seen.${id}`) ?? 'null')

describe('"What changed", as the member uses it', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getSelectedVault.mockReturnValue(A)
    getVault.mockResolvedValue({ id: A, name: 'Caixa', threshold: 2, total: 3 })
    listVaults.mockResolvedValue([{ id: A, myName: 'Ana' }, { id: B, myName: 'Ana' }])
  })
  afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); poll.fn = null })

  it('with no vault selected, says so instead of "nothing changed", and asks for nothing', async () => {
    getSelectedVault.mockReturnValue(null)
    getProposals.mockResolvedValue([p('x', 'ready')])
    mount()
    await screen.findByText(en('since.noVault'))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText(en('since.nothing'))).toBeNull()
    expect(screen.queryByText(en('since.firstTime'))).toBeNull()
    expect(screen.queryByRole('button', { name: en('since.markSeen') })).toBeNull()
    expect(getProposals).not.toHaveBeenCalled()
  })

  it('a first look takes this vault\'s snapshot, says there is nothing to compare, and offers nothing to mark', async () => {
    localStorage.setItem(`konclave.seen.${B}`, JSON.stringify({ at: 5, states: { x: 'awaiting' } }))
    getProposals.mockResolvedValue([p('x', 'ready')])
    mount()
    await screen.findByText(en('since.firstTime'), { selector: 'p.hint' })
    expect(seenOf(A).states).toEqual({ x: 'ready' })
    // the other vault's snapshot is neither read nor touched
    expect(seenOf(B)).toEqual({ at: 5, states: { x: 'awaiting' } })
    expect(markBtn().getAttribute('aria-disabled')).toBe('true')
  })

  it('a change that arrives on a later read during that first look is shown, and only then can be marked', async () => {
    localStorage.setItem(`konclave.seen.${B}`, JSON.stringify({ at: 5, states: { x: 'awaiting' } }))
    getProposals.mockResolvedValue([p('x', 'awaiting', { approvals: ['Ana'] })])
    mount()
    await screen.findByText(en('since.firstTime'), { selector: 'p.hint' })
    getProposals.mockResolvedValue([p('x', 'ready', { approvals: ['Ana'] })])
    await tick()
    await screen.findByRole('button', { name: `Rent x, ${en('stamp.ready')}` })
    expect(screen.queryByText(en('since.firstTime'), { selector: 'p.hint' })).toBeNull()
    expect(markBtn().getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(markBtn())
    expect(seenOf(A).states).toEqual({ x: 'ready' })
    expect(seenOf(B)).toEqual({ at: 5, states: { x: 'awaiting' } })
    expect(Object.keys(localStorage).filter((k) => k.startsWith('konclave.seen.')).sort()).toEqual([`konclave.seen.${A}`, `konclave.seen.${B}`])
  })

  it('names a ready proposal "Ready" whoever signs, and never reads the amount out in clear', async () => {
    localStorage.setItem(`konclave.seen.${A}`, JSON.stringify({ at: 5, states: { x: 'awaiting' } }))
    getProposals.mockResolvedValue([p('x', 'ready', { approvals: ['Bia'] })])
    mount()
    const row = await screen.findByRole('button', { name: `Rent x, ${en('stamp.ready')}` })
    expect(row.getAttribute('aria-label')).not.toMatch(/1\.5/)
    // the amount stays under its bar, and the bar is not a button inside the row's button
    expect(document.querySelector('button button')).toBeNull()
    fireEvent.click(document.querySelector('.since-row .secret button.bar')!)
    expect(screen.queryByText('PROPOSAL PAGE')).toBeNull()
    fireEvent.click(row)
    await screen.findByText('PROPOSAL PAGE')
  })

  it('says so when a later read fails, instead of showing the old list as current', async () => {
    localStorage.setItem(`konclave.seen.${A}`, JSON.stringify({ at: 5, states: { x: 'awaiting' } }))
    getProposals.mockResolvedValue([p('x', 'ready')])
    mount()
    await screen.findByRole('button', { name: `Rent x, ${en('stamp.ready')}` })
    expect(document.querySelector('.read-state')).toBeNull()
    getProposals.mockResolvedValue(null)
    await tick()
    await tick()
    // the compact line above the rows the screen still holds, with its retry
    await waitFor(() => expect(document.querySelector('.read-state.compact')?.textContent).toContain(en('read.stale')))
    expect(screen.getByRole('button', { name: `Rent x, ${en('stamp.ready')}` })).toBeTruthy()
  })

  it('reads who this device is once, not on every read of the list', async () => {
    localStorage.setItem(`konclave.seen.${A}`, JSON.stringify({ at: 5, states: {} }))
    getProposals.mockResolvedValue([p('x', 'awaiting')])
    mount()
    await screen.findByRole('button', { name: `Rent x, ${en('since.kind.arrived')}` })
    await tick(); await tick(); await tick()
    await waitFor(() => expect(getProposals.mock.calls.length).toBeGreaterThanOrEqual(4))
    expect(listVaults).toHaveBeenCalledTimes(1)
  })
})
