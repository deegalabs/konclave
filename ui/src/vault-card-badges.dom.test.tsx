// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
import { fmtDate, fmtDateTime } from './format'
const en = (k: string, vars: Record<string, string> = {}): string =>
  Object.entries(vars).reduce((s, [a, b]) => s.replace(`{${a}}`, b), dict[k] ?? k)

// The vault card's figures as badges, each explaining itself, over the real list.
const h = vi.hoisted(() => ({ list: vi.fn(), select: vi.fn() }))
vi.mock('./screens/NetVault', () => ({ default: () => null }))
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), helperConfigured: () => true }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health: async () => false, getVaults: async () => [], isVaultUnlocked: () => false, setSelectedVault: h.select }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: h.list, readVaults: h.list }))
const Vaults = (await import('./screens/Vaults')).default

// jsdom has no PointerEvent: without one the pointer type a handler reads would be lost.
beforeAll(() => {
  if (!('PointerEvent' in window)) {
    class PE extends MouseEvent {
      pointerType: string
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? '' }
    }
    ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PE
  }
})

// Whether the focus came from the keyboard: jsdom does not know `:focus-visible`, so the test says.
let focusVisible = false
const realMatches = Element.prototype.matches
beforeEach(() => {
  focusVisible = false
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
    return sel === ':focus-visible' ? focusVisible : realMatches.call(this, sel)
  })
  localStorage.clear()
  h.select.mockClear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const rec = (id: string, name: string, over: object = {}) => ({ id, name, governance: 'quorum', myName: 'A', creatorName: 'A', groupKey: id, address: 'u1aaaa', roster: ['A', 'B'], createdAt: 1, threshold: 2, total: 2, ...over })
const NOW = Math.floor(Date.now() / 1000)
const status = (id: string, s: object) => localStorage.setItem(`konclave.status.${id}`, JSON.stringify(s))
const show = () => render(<MemoryRouter><I18nProvider><ToastProvider><Vaults /></ToastProvider></I18nProvider></MemoryRouter>)
// The list mounts on the first card a test asks for, after the test has set the records and figures.
let mounted = false
beforeEach(() => { mounted = false })
const cardOf = async (name: string) => {
  if (!mounted) { show(); mounted = true }
  return (await screen.findByRole('heading', { name, level: 3 })).closest('.rd-card') as HTMLElement
}
const badges = (card: HTMLElement) => [...card.querySelectorAll('.rd-badges .rd-badge')] as HTMLElement[]
const tipOf = (el: Element) => document.getElementById(el.getAttribute('aria-describedby')!)!

// An open vault: its figures live on the device. 80 000 zat spendable, nothing reserved.
const openStatus = (over: object = {}) => ({ totalZat: 80_000, spendableZat: 80_000, reservedZat: 0, balanceAt: NOW - 600, proposalsAt: NOW - 60, openCount: 0, lastActivity: NOW - 2 * 86_400, ...over })

describe('the badges', () => {
  it('say open, last and free, in that order, in the reviewed words', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    status(A, openStatus())
    const card = await cardOf('Alpha')
    const [open, last, free] = badges(card)
    expect(badges(card)).toHaveLength(3)
    expect(open!.textContent).toBe(en('vaults.badgeNoOpen'))
    expect(last!.textContent).toBe(en('vaults.badgeLast', { date: fmtDate(NOW - 2 * 86_400, 'en') }))
    expect(free!.textContent).toContain(en('vaults.badgeFree', { amount: '' }).trim())
    // Zero is quiet; a count that needs someone is not.
    expect(open!.classList.contains('zero')).toBe(true)
  })
  it('a count that is not zero stands out, and says one or many', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha'), rec(B, 'Beta')])
    status(A, openStatus({ openCount: 1 }))
    status(B, openStatus({ openCount: 3 }))
    const [a] = badges(await cardOf('Alpha'))
    const [b] = badges(await cardOf('Beta'))
    expect(a!.textContent).toBe(en('vaults.badgeOpenOne'))
    expect(b!.textContent).toBe(en('vaults.badgeOpen', { n: '3' }))
    expect(b!.classList.contains('zero')).toBe(false)
  })
  it('one read line, with the time of the amount, and no other date written twice', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    status(A, openStatus())
    const card = await cardOf('Alpha')
    // The amount is made of both reads; it carries the older one.
    expect(card.querySelector('.rd-read')!.textContent).toBe(en('vaults.readAt', { when: fmtDateTime(NOW - 600, 'en') }))
    expect(card.querySelectorAll('.rd-read')).toHaveLength(1)
    expect(card.textContent!.split(fmtDateTime(NOW - 600, 'en')).length - 1).toBe(1)
  })
  it('past a day, the read line says so in words, and the card greys', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    status(A, openStatus({ balanceAt: NOW - 90_000 }))
    const card = await cardOf('Alpha')
    expect(card.querySelector('.rd-read')!.textContent).toBe(en('vaults.readAtStale', { when: fmtDateTime(NOW - 90_000, 'en') }))
    expect(card.querySelector('.rd-figs')!.classList.contains('stale')).toBe(true)
  })
  it('a private vault not unlocked here shows no amount anywhere, and ages by its proposals read', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    status(A, { private: true, balanceAt: NOW - 60, proposalsAt: NOW - 90_000, openCount: 1, lastActivity: NOW - 90_000 })
    const card = await cardOf('Alpha')
    expect(badges(card)).toHaveLength(2)
    expect(card.textContent).not.toMatch(/ZEC/)
    for (const t of card.querySelectorAll('[role="tooltip"]')) expect(t.textContent).not.toMatch(/\d+[.,]\d+ ?ZEC|0[.,]0008/)
    expect(card.querySelector('.rd-read')!.textContent).toBe(en('vaults.readAtStale', { when: fmtDateTime(NOW - 90_000, 'en') }))
    expect(card.querySelector('.rd-figs')!.classList.contains('stale')).toBe(true)
  })
  it('a vault never read here shows the one badge, explained, and no paragraph', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    const card = await cardOf('Alpha')
    const [only] = badges(card)
    expect(badges(card)).toHaveLength(1)
    expect(only!.textContent).toBe(en('vaults.badgeUnread'))
    expect(tipOf(only!).textContent).toBe(en('vaults.stateNone'))
    expect(card.querySelector('.rd-read')).toBeNull()
    expect(screen.getAllByText(en('vaults.stateNone')).every((n) => n.getAttribute('role') === 'tooltip')).toBe(true)
  })
})

describe('entering, and what does not enter', () => {
  it('"Enter →" is the button, named for the vault; the heading is a heading', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    const card = await cardOf('Alpha')
    expect(card.getAttribute('role')).toBeNull()
    expect(card.hasAttribute('tabindex')).toBe(false)
    const go = within(card).getByRole('button', { name: en('vaults.enterNamed', { name: 'Alpha' }) })
    expect(go.textContent).toContain(en('vaults.enter'))
    expect(within(card).getByRole('heading', { name: 'Alpha' }).hasAttribute('tabindex')).toBe(false)
    fireEvent.click(go)
    expect(h.select).toHaveBeenCalledWith(A)
  })
  it('a click on the card enters; on a badge, its tip, the veil or Remove it does not', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    status(A, openStatus())
    const card = await cardOf('Alpha')
    const [open, , free] = badges(card)
    fireEvent.click(open!)
    fireEvent.click(tipOf(open!))
    fireEvent.click(free!.querySelector('.bar')!)
    fireEvent.click(free!) // the words beside the veil are the badge's too
    expect(h.select).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('heading', { name: 'Alpha' }))
    expect(h.select).toHaveBeenCalledTimes(1)
  })  // The card's notes are the member's to read and act on, and the one guard is what keeps a click on
  // them from entering: no note on the card stops the click itself, so the click must reach the document.
  // (The viewing-code note shows only while the code is not compared, and entering refuses then too;
  // what that test can catch is a note that swallows the click again.)
  // Listened for on the document: React handles clicks at its root, above the card, so a note's
  // stopPropagation stops the click there, and only a listener past the root can tell.
  const reachesDocument = () => {
    const spy = vi.fn()
    document.addEventListener('click', spy)
    onTestFinished(() => document.removeEventListener('click', spy))
    return spy
  }
  it('a click on the viewing-code note does not enter', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha', { cp: 3, receiversState: 'verified', viewingFingerprint: 'ABCDE-FGHJK-MNPQR-STVWX-YZ012' })])
    const card = await cardOf('Alpha')
    const note = card.querySelector('.fp-card') as HTMLElement
    expect(note).not.toBeNull()
    const bubbled = reachesDocument()
    fireEvent.click(note.querySelector('.fp-code')!)
    fireEvent.click(note.querySelector('.fp-help')!)
    expect(bubbled).toHaveBeenCalledTimes(2)
    expect(h.select).not.toHaveBeenCalled()
  })
  it('a click on the plain-key notice does not enter', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha', { plainViewingKey: true })])
    const card = await cardOf('Alpha')
    const note = card.querySelector('.plain-key') as HTMLElement
    expect(note).not.toBeNull()
    const bubbled = reachesDocument()
    fireEvent.click(note)
    fireEvent.click(note.querySelector('strong')!)
    fireEvent.click(note.querySelector('p')!)
    expect(bubbled).toHaveBeenCalledTimes(3)
    expect(h.select).not.toHaveBeenCalled()
  })
})

describe('the tips', () => {
  const ready = async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    status(A, openStatus({ openCount: 2 }))
    const card = await cardOf('Alpha')
    const [open, last] = badges(card)
    return { card, open: open!, last: last! }
  }
  const shown = (el: Element) => !tipOf(el).hidden

  it('each tip is a sibling of its badge, described by id, kept in the page while hidden', async () => {
    const { card, open } = await ready()
    const tip = tipOf(open)
    expect(tip.getAttribute('role')).toBe('tooltip')
    expect(open.contains(tip)).toBe(false)
    expect(tip.hidden).toBe(true)
    expect(open.hasAttribute('aria-expanded')).toBe(false)
    expect(tip.textContent).toBe(en('vaults.tipOpen'))
    const ids = [...card.querySelectorAll('[role="tooltip"]')].map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('a mouse hover opens it; a touch passing over does not', async () => {
    const { open, last } = await ready()
    fireEvent.pointerEnter(open, { pointerType: 'touch' })
    expect(shown(open)).toBe(false)
    fireEvent.pointerEnter(last, { pointerType: 'mouse' })
    expect(shown(last)).toBe(true)
  })
  it('focus from the keyboard opens it; focus from a click does not', async () => {
    const { open, last } = await ready()
    focusVisible = false
    fireEvent.focus(open)
    expect(shown(open)).toBe(false)
    focusVisible = true
    fireEvent.focus(last)
    expect(shown(last)).toBe(true)
    fireEvent.blur(last)
    expect(shown(last)).toBe(false)
  })
  it('Enter on a badge keeps open the tip its keyboard focus opened; a second Enter closes it', async () => {
    const { open } = await ready()
    focusVisible = true
    fireEvent.focus(open)
    expect(shown(open)).toBe(true)
    fireEvent.click(open) // what Enter on a focused button does: a click with no pointer
    expect(shown(open)).toBe(true)
    fireEvent.click(open)
    expect(shown(open)).toBe(false)
  })
  it('one tap opens it and leaves it open', async () => {
    const { open } = await ready()
    fireEvent.pointerDown(open, { pointerType: 'touch' })
    fireEvent.pointerUp(open, { pointerType: 'touch' })
    fireEvent.focus(open)
    fireEvent.click(open)
    expect(shown(open)).toBe(true)
    // A second tap closes it.
    fireEvent.pointerDown(open, { pointerType: 'touch' })
    fireEvent.click(open)
    expect(shown(open)).toBe(false)
  })
  it('Esc closes it and keeps the focus; a tap outside closes it; one at a time', async () => {
    const { open, last } = await ready()
    open.focus()
    fireEvent.click(open)
    expect(shown(open)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(shown(open)).toBe(false)
    expect(document.activeElement).toBe(open)
    fireEvent.click(open)
    fireEvent.click(last)
    expect(shown(open)).toBe(false)
    expect(shown(last)).toBe(true)
    fireEvent.pointerDown(document.body, { pointerType: 'touch' })
    expect(shown(last)).toBe(false)
  })
  it('the pointer can move onto the tip: leaving the badge closes only after a pause the tip cancels', async () => {
    const { open } = await ready()
    vi.useFakeTimers()
    fireEvent.pointerEnter(open, { pointerType: 'mouse' })
    fireEvent.pointerLeave(open, { pointerType: 'mouse' })
    fireEvent.pointerEnter(tipOf(open), { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(shown(open)).toBe(true)
    fireEvent.pointerLeave(tipOf(open), { pointerType: 'mouse' })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(shown(open)).toBe(false)
  })
  it('the veil over the amount is described by its tip, and a tap on it opens the tip', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha')])
    status(A, openStatus())
    const card = await cardOf('Alpha')
    const bar = badges(card)[2]!.querySelector('button.bar')!
    expect(tipOf(bar).textContent).toBe(en('vaults.tipFree'))
    fireEvent.pointerDown(bar, { pointerType: 'touch' })
    fireEvent.click(bar)
    expect(tipOf(bar).hidden).toBe(false)
  })
  it('the Private and Open tags explain themselves through the same tip, in their words of today', async () => {
    h.list.mockResolvedValue([rec(A, 'Alpha', { secured: true }), rec(B, 'Beta', { secured: false })])
    const a = await cardOf('Alpha')
    const b = await cardOf('Beta')
    const priv = within(a).getByRole('button', { name: en('vaults.securedBadge') })
    const open = within(b).getByRole('button', { name: new RegExp(en('vaults.openBadge')) })
    for (const [tag, k] of [[priv, 'vaults.securedHint'], [open, 'vaults.openHint']] as const) {
      expect(tag.hasAttribute('title')).toBe(false)
      expect(tipOf(tag).textContent).toBe(en(k))
    }
  })
})
