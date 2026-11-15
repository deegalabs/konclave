// @vitest-environment jsdom
// #625: the invite code and its QR stay out of the page until the creator asks. "Hidden" means
// absent from the tree (text AND attributes), not covered; the PIN never reaches anything the
// invite card copies, shares or draws.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import encodeQR from '@paulmillr/qr'
import { InviteCard } from './screens/CeremonyParts'
import { formatInvite, formatRoomPin, inviteLink, spokenRoomPin } from './net'

// The real encoder, observed: a mock that returns no svg would make "no svg" vacuous.
vi.mock('@paulmillr/qr', async (orig) => {
  const m = await orig<typeof import('@paulmillr/qr')>()
  return { ...m, default: vi.fn(m.default) }
})

const CODE = '0123456789ABCDEFGHJKMNPQRS'
const PIN = '482193' // not a substring of CODE, the link or its formatted forms
const pe = (_pt: string, en: string) => en
const qr = vi.mocked(encodeQR)

const flat = (s: string) => s.replace(/[\s,\-]/g, '').toUpperCase()
/** True when `needle` is in any text node or any attribute value, whatever the separators. */
function carries(root: Element, needle: string): boolean {
  const n = flat(needle)
  if (flat(root.textContent ?? '').includes(n)) return true
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))])
    for (const a of Array.from(el.attributes)) if (flat(a.value).includes(n)) return true
  return false
}
const forms = [CODE, formatInvite(CODE), 'join=']

let writeText: ReturnType<typeof vi.fn>
let share: ReturnType<typeof vi.fn>
beforeEach(() => {
  writeText = vi.fn(async () => {})
  share = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  Object.defineProperty(navigator, 'share', { value: share, configurable: true })
  qr.mockClear()
})
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(navigator, 'share') })

const card = () => render(<InviteCard code={CODE} pin={PIN} pe={pe} />).container
const statusText = () => document.querySelector('.cv-status')!.textContent
const showCode = () => screen.getByRole('button', { name: /show the invite code/i })

describe('the invite code is hidden until asked for', () => {
  it('is in neither the text nor any attribute, in any of its forms, and there is no QR', () => {
    const root = card()
    for (const f of forms) expect(carries(root, f), f).toBe(false)
    expect(carries(root, inviteLink(CODE))).toBe(false)
    expect(root.querySelector('svg, .cv-invite-qr')).toBeNull()
    expect(qr).not.toHaveBeenCalled()
  })

  it('shows on request, the toggle keeps focus, and hiding takes it out of the tree again', () => {
    const root = card()
    const toggle = showCode()
    toggle.focus()
    fireEvent.click(toggle)
    expect(carries(root, CODE)).toBe(true)
    expect(root.querySelector('.cv-group')).not.toBeNull()
    expect(document.activeElement).toBe(toggle)
    expect(toggle.textContent).toMatch(/hide the invite code/i)
    expect(statusText()).toBe('Invite code shown.')
    expect(statusText()).not.toMatch(/0 1 2|0123/) // the code is not spoken by a status region
    fireEvent.click(toggle)
    for (const f of forms) expect(carries(root, f), f).toBe(false)
    expect(document.activeElement).toBe(toggle)
    expect(statusText()).toBe('Invite code hidden.')
  })

  it('names the hidden state once, in the accessibility tree', () => {
    const root = card()
    const ph = screen.getByRole('button', { name: /copy the invite code \(hidden\)/i })
    expect(ph.tagName).toBe('BUTTON')
    expect(root.textContent!.match(/hidden/gi)!.length).toBeGreaterThan(0)
    expect(root.querySelectorAll('[role="button"]').length).toBe(0)
    expect(root.innerHTML).not.toMatch(/aria-pressed|aria-expanded/)
  })

  it('copies the raw code while hidden, from the button and from the placeholder, and stays hidden', async () => {
    const root = card()
    fireEvent.click(screen.getByRole('button', { name: /copy the code only/i }))
    await waitFor(() => expect(statusText()).toBe('Code copied.'))
    fireEvent.click(screen.getByRole('button', { name: /copy the invite code \(hidden\)/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText).toHaveBeenNthCalledWith(1, CODE)
    expect(writeText).toHaveBeenNthCalledWith(2, CODE)
    for (const f of forms) expect(carries(root, f), f).toBe(false)
  })

  it('says a refused copy, one way hidden and another way shown', async () => {
    writeText.mockRejectedValue(new Error('no'))
    const root = card()
    fireEvent.click(screen.getByRole('button', { name: /copy the code only/i }))
    await waitFor(() => expect(statusText()).toBe('Could not copy here. Show the code and copy it by hand.'))
    expect(carries(root, CODE)).toBe(false)
    fireEvent.click(showCode())
    fireEvent.click(screen.getByRole('button', { name: /copy the code only/i }))
    await waitFor(() => expect(statusText()).toBe('Could not copy here. Press and hold the code to copy it.'))
  })

  it('an old status timer does not wipe a newer message', async () => {
    vi.useFakeTimers()
    card()
    fireEvent.click(showCode()) // "shown", timer A
    await act(() => vi.advanceTimersByTimeAsync(2000))
    fireEvent.click(screen.getByRole('button', { name: /hide the invite code/i })) // "hidden", timer B
    await act(() => vi.advanceTimersByTimeAsync(1000)) // A would fire here
    expect(statusText()).toBe('Invite code hidden.')
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(statusText()).toBe('')
  })
})

describe('the QR is drawn only on request', () => {
  it('is absent, then drawn by the real encoder from the link, then gone', () => {
    const root = card()
    const toggle = screen.getByRole('button', { name: /show the invite qr/i })
    toggle.focus()
    fireEvent.click(toggle)
    expect(qr).toHaveBeenCalledTimes(1)
    expect(qr.mock.calls[0]).toEqual([inviteLink(CODE), 'svg'])
    expect(root.querySelector('.cv-invite-qr svg')).not.toBeNull()
    expect(document.activeElement).toBe(toggle)
    expect(toggle.textContent).toMatch(/hide the invite qr/i)
    expect(root.querySelector('.cv-invite-qr')!.getAttribute('aria-label')).toMatch(/PIN is not in it/)
    fireEvent.click(toggle)
    expect(root.querySelector('svg, .cv-invite-qr')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('the warning says what a camera gets, and that the PIN is what keeps a stranger out', () => {
    card()
    fireEvent.click(screen.getByRole('button', { name: /show the invite qr/i }))
    expect(document.body.textContent).toMatch(/Any camera that sees this screen has the invite\. The PIN is what keeps a stranger out/)
  })
})

describe('share is offered only where the browser has it', () => {
  it('has no Share button without navigator.share', () => {
    Reflect.deleteProperty(navigator, 'share')
    card()
    expect(screen.queryByRole('button', { name: /share invite/i })).toBeNull()
  })
})

describe('the PIN reaches nothing the card copies, shares or draws', () => {
  it('payloads are exactly the code and the link; the PIN is not in the masked tree', async () => {
    const root = card()
    fireEvent.click(screen.getByRole('button', { name: /share invite/i }))
    fireEvent.click(screen.getByRole('button', { name: /copy invite link/i }))
    fireEvent.click(screen.getByRole('button', { name: /copy the code only/i }))
    fireEvent.click(screen.getByRole('button', { name: /show the invite qr/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(share).toHaveBeenCalledTimes(1)
    expect(share).toHaveBeenCalledWith({ url: inviteLink(CODE) })
    expect(writeText).toHaveBeenNthCalledWith(1, inviteLink(CODE))
    expect(writeText).toHaveBeenNthCalledWith(2, CODE)
    expect(qr).toHaveBeenCalledTimes(1)
    expect(qr.mock.calls[0]![0]).toBe(inviteLink(CODE))
    for (const p of [PIN, formatRoomPin(PIN), spokenRoomPin(PIN)]) {
      expect(carries(root, p), p).toBe(false)
      expect(inviteLink(CODE).includes(p)).toBe(false)
    }
  })
})
