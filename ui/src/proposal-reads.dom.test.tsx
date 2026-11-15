// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
const en = (k: string, v: Record<string, string> = {}): string => {
  const s = dict[k]
  if (s === undefined) throw new Error(`no English text for ${k}`)
  return Object.entries(v).reduce((acc, [name, x]) => acc.replace(`{${name}}`, x), s)
}

// #970, at the level of the screen: the real proposal screen over the real readers, a fetch that
// answers and is counted. On the web, opening a proposal a member can still act on reads the vault's
// proposals ONCE: the "Worth a second look" note compares against the list the proposal came from.
// No cache: the screen's poll still reads a fresh list.

const VAULT = 'ab'.repeat(32)
const A = (c: string) => 'u1' + c.repeat(76)
const OLD = A('o')
const NEW = A('n')
const T0 = 1759000000
const row = (id: string, to: string, state: string, at: number, amount_zat = 100) => ({
  id, vault_id: VAULT, kind: 'payment', to, amount_zat, proposer: 'Alice', state,
  approvals: ['Alice'], refusals: [], threshold: 2, total: 2, created_at_unix: at, expiry_unix: 0,
})
const ROWS = [
  row('p-new', NEW, 'pending', T0 + 100),
  // Paid ten times what OLD was paid three times before: only the real book makes this "above usual".
  row('p-big', OLD, 'pending', T0 + 90, 1000),
  row('p-sent', OLD, 'sent', T0 + 50),
  row('old2', OLD, 'confirmed', T0 + 20),
  row('old', OLD, 'confirmed', T0),
  // A payroll that pays OLD 200 after one that paid OLD 100: "a different amount" needs the earlier
  // payroll's LINES from the same read.
  { ...row('r-now', '', 'pending', T0 + 95, 200), kind: 'payroll', lines: [{ label: 'Old', to: OLD, amount_zat: 200 }] },
  { ...row('r-prev', '', 'confirmed', T0 + 10, 100), kind: 'payroll', lines: [{ label: 'Old', to: OLD, amount_zat: 100 }] },
]

const polls: Array<() => void> = []

async function setup(id: string) {
  vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
  localStorage.setItem('konclave.selectedVault', VAULT)
  localStorage.setItem('konclave.locale', 'en')
  vi.resetModules()
  vi.doMock('./usePoll', async (orig) => ({
    ...(await orig<typeof import('./usePoll')>()),
    usePoll: (fn: () => void, _ms: number, on = true) => { if (on) polls.push(fn) },
  }))
  vi.doMock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
  vi.doMock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {} }) }))
  vi.doMock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
    const url = String(u)
    urls.push(url)
    if (new URL(url, 'http://local').pathname === '/api/vault/proposals') return new Response(JSON.stringify({ proposals: ROWS }), { status: 200 })
    return new Response('{}', { status: 404 })
  }))
  const { I18nProvider } = await import('./i18n')
  const { default: Proposal } = await import('./screens/Proposal')
  const { shortAddr } = await import('./format')
  render(
    <MemoryRouter initialEntries={[{ pathname: '/proposal', state: { id } }]}><I18nProvider><Proposal /></I18nProvider></MemoryRouter>,
  )
  const lists = () => urls.filter((u) => new URL(u, 'http://local').pathname === '/api/vault/proposals').length
  return { lists, shortAddr }
}

describe('the proposal screen reads the vault proposals once when it opens on the web (#970)', () => {
  afterEach(() => {
    cleanup()
    for (const m of ['./usePoll', './storage', './VaultSigner', './toast']) vi.doUnmock(m)
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear(); polls.length = 0
  })

  it('an awaiting proposal: one read, and the note compares against it', async () => {
    const s = await setup('p-new')
    // A real finding, not just the note's region: the book (the same list) never paid NEW.
    expect(await screen.findByText(en('unusual.first', { who: s.shortAddr(NEW) }))).toBeTruthy()
    expect(s.lists()).toBe(1)
  })

  it('the note reads the real book from that one read: above usual needs the earlier payments', async () => {
    const s = await setup('p-big')
    // An empty or wrong book would say "no earlier payment"; only the list's three settled payments
    // to OLD make 1000 "above usual".
    expect(await screen.findByText(en('unusual.above', { who: `Old (${s.shortAddr(OLD)})` }))).toBeTruthy()
    expect(screen.queryByText(en('unusual.first', { who: `Old (${s.shortAddr(OLD)})` }))).toBeNull()
    expect(s.lists()).toBe(1)
  })

  it('a payroll is compared with the previous payroll lines from that one read', async () => {
    const s = await setup('r-now')
    // Without the earlier payroll's lines the reading is partial and names no change.
    expect(await screen.findByText(en('unusual.amount', { who: `Old (${s.shortAddr(OLD)})` }))).toBeTruthy()
    expect(s.lists()).toBe(1)
  })

  it('a sent proposal: one read (the note does not read for it)', async () => {
    const s = await setup('p-sent')
    await screen.findAllByText(new RegExp(s.shortAddr(OLD).slice(0, 8)))
    await new Promise((r) => setTimeout(r, 20))
    expect(s.lists()).toBe(1)
  })

  it('the poll still reads a fresh list (no cache)', async () => {
    const s = await setup('p-new')
    await screen.findByText(en('unusual.first', { who: s.shortAddr(NEW) }))
    expect(s.lists()).toBe(1)
    expect(polls.length).toBeGreaterThan(0)
    polls[polls.length - 1]!()
    await vi.waitFor(() => expect(s.lists()).toBe(2))
  })
})

describe('one book, one implementation (#970)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear() })

  it('the book from the proposal read equals getBookWithLines over the same list', async () => {
    vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
    localStorage.setItem('konclave.selectedVault', VAULT)
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ proposals: ROWS }), { status: 200 })))
    const { getBookWithLines, getProposalDetail } = await import('./api')
    const d = await getProposalDetail('p-new')
    expect(typeof d!.book).toBe('function')
    expect(d!.book!()).toEqual(await getBookWithLines())
  })
})
