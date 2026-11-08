// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The signing sheet says it is modal, so it moves focus in, traps Tab, closes on
// Escape only when nothing is running, returns focus to the opener, and does not let "Sign" turn into
// "Send" in silence.
const PAY = 'utest1cx3tarwlxt8vw60ugpddnsjemj3aum5nhkwpdyy0kn0urhhq27lu0q3ajv4whnav4mschgsnum4tvt5l22zs47ccltyfrxqwkcal5m47'
const st = vi.hoisted(() => ({
  bg: {} as Record<string, unknown>,
  active: true,
  armed: false,
  plan: undefined as unknown,
  unarm: vi.fn(async () => {}),
  close: vi.fn(),
}))
vi.mock('./VaultSigner', () => ({
  useVaultSigner: () => ({
    bg: st.bg,
    vault: { id: 'vtest000', group_pubkey: 'gp', member_list: [{ name: 'Ana' }, { name: 'Bia' }] },
    threshold: 2, myName: 'Ana',
    active: st.active ? { id: 'p1', kind: 'payment', to_address: PAY, value_zec: '1', state: 'ready' } : null,
    open: () => {}, close: st.close, reseat: () => {}, armed: st.armed,
    unarmActive: st.unarm, armActive: async () => {}, armedUntil: null,
    isOurReceiver: () => false, signedBefore: null,
    plan: st.plan === undefined ? { kind: 'payment', totalZat: 100_000_000, lines: [{ address: PAY, amountZat: 100_000_000, memo: '', isPublic: false }] } : st.plan, planFailed: false,
  }),
}))
vi.mock('./session', async (orig) => ({ ...(await orig<typeof import('./session')>()), getUnlockedShare: () => ({ myName: 'Ana' }), unlockedHere: () => true }))
vi.mock('./toast', () => ({ useToast: () => ({ show: () => {}, ok: () => {}, err: () => {}, warn: () => {} }) }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getBalance: async () => null, getProposalDetail: async () => null, listProposals: async () => [] }))

const { I18nProvider } = await import('./i18n')
const { default: SigningPanel } = await import('./screens/SigningPanel')

const base = { ready: true, phase: 'idle', error: '', what: null, seatCount: 2, armedSeats: [], iSend: false, peerFailure: null, clearPeerFailure: () => {}, signature: null, wouldComplete: () => false, sendingNamed: () => false, completed: () => null }
const tree = () => <MemoryRouter><I18nProvider><SigningPanel /></I18nProvider></MemoryRouter>
const sheet = () => document.querySelector('.sign-sheet') as HTMLElement

describe('the signing sheet as a modal', () => {
  beforeEach(() => { localStorage.setItem('konclave.locale', 'en'); st.bg = { ...base }; st.active = true; st.armed = false; st.plan = undefined; st.unarm.mockClear(); st.close.mockReset() })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('moves focus inside on open', () => {
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus()
    render(tree())
    expect(sheet().contains(document.activeElement)).toBe(true)
  })

  it('keeps Tab and Shift+Tab inside the sheet', () => {
    render(tree())
    const f = Array.from(sheet().querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled])'))
    f[f.length - 1]!.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(f[0])
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(f[f.length - 1])
  })

  it('closes on Escape when idle, and not while a run is in progress', () => {
    const { rerender } = render(tree())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(st.close).toHaveBeenCalledTimes(1)
    st.bg = { ...base, phase: 'signing' }
    rerender(tree())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(st.close).toHaveBeenCalledTimes(1)
  })

  it('does not close on Escape while this device waits after signing', () => {
    st.armed = true
    render(tree())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(st.close).not.toHaveBeenCalled()
  })

  it('keeps Tab inside from a message that takes no Tab stop, after the last control', () => {
    render(tree())
    const msg = document.createElement('div'); msg.tabIndex = -1; sheet().appendChild(msg); msg.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(sheet().contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(msg)
  })

  it('returns focus to the opener when the sheet closes', () => {
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus()
    const { rerender } = render(tree())
    expect(document.activeElement).not.toBe(opener)
    st.active = false
    rerender(tree())
    expect(document.activeElement).toBe(opener)
  })

  it('closes the confirm and announces it when "Sign" would become "Send"', () => {
    const { rerender } = render(tree())
    fireEvent.click(screen.getByRole('button', { name: /^Sign/ }))
    expect(document.querySelector('.sign-confirm')).not.toBeNull()
    st.bg = { ...base, wouldComplete: () => true }
    act(() => { rerender(tree()) })
    expect(document.querySelector('.sign-confirm')).toBeNull()
    expect(screen.getAllByRole('status').map((e) => e.textContent).join(' ')).toContain('changed while this was open')
  })

  it('closes the confirm when the reading of the payment is refused while it is open', () => {
    const { rerender } = render(tree())
    fireEvent.click(screen.getByRole('button', { name: /^Sign/ }))
    expect(document.querySelector('.sign-confirm')).not.toBeNull()
    st.plan = null
    act(() => { rerender(tree()) })
    expect(document.querySelector('.sign-confirm')).toBeNull()
  })

  it('announces the stage moving from waiting to ready', () => {
    st.bg = { ...base, seatCount: 1 }
    const { rerender } = render(tree())
    const live = () => Array.from(document.querySelectorAll('.sign-sheet > [role=status]')).map((e) => e.textContent).join('')
    expect(live()).toContain('Waiting for the other signers')
    st.bg = { ...base, seatCount: 2 }
    rerender(tree())
    expect(live()).toContain('Everyone needed is here')
  })
})
