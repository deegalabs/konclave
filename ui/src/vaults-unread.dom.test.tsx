// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #320: the Vaults list is read from this browser's storage. When that read failed, the list came
// back empty and the screen said "No vaults yet", which invites a member to create or import again
// over a vault that is still there. This mounts the real screen with a storage that fails, then
// answers, and reads what a member sees at each step.
const listVaults = vi.hoisted(() => vi.fn())
const health = vi.hoisted(() => vi.fn(async () => false))
const getVaults = vi.hoisted(() => vi.fn(async () => null))
const net = vi.hoisted(() => ({ on: false }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health, getVaults, get IS_NET() { return net.on } }))

const { default: Vaults } = await import('./screens/Vaults')
// The message is found by its component, not by role: the toast provider keeps live regions of its
// own on the page, an alert among them, so "the alert" is not one element there.
const said = () => document.querySelector('.read-state')
const mount = () => render(<MemoryRouter><I18nProvider><ToastProvider><Vaults /></ToastProvider></I18nProvider></MemoryRouter>)

const saved = {
  id: 'ab'.repeat(32), name: 'Treasury', roster: ['Ana', 'Bia'], threshold: 2, groupKey: 'ab'.repeat(32),
  address: 'u1test', secured: true, pending: false, plainViewingKey: false,
}

describe('the Vaults screen when this browser could not read its vaults (#320)', () => {
  beforeEach(() => { net.on = false; listVaults.mockReset(); health.mockReset(); health.mockResolvedValue(false); getVaults.mockReset(); getVaults.mockResolvedValue(null) })
  afterEach(() => cleanup())

  it('says it could not read, never "No vaults yet", and warns against creating again', async () => {
    listVaults.mockRejectedValue(new Error('storage closed'))
    mount()
    expect(await screen.findByText(en('vaults.unreadTitle'))).toBeTruthy()
    expect(said()!.textContent).toContain(en('vaults.unreadHolds'))
    expect(said()!.textContent).toContain(en('read.unavailable').replace('{who}', en('read.who.device')))
    expect(screen.queryByText(en('vaults.empty'))).toBeNull()
  })

  it('reads again on "Try again", and the list replaces the message', async () => {
    listVaults.mockRejectedValueOnce(new Error('storage closed')).mockResolvedValue([saved])
    mount()
    fireEvent.click(await screen.findByRole('button', { name: en('read.retry') }))
    expect(await screen.findByText('Treasury')).toBeTruthy()
    expect(screen.queryByText(en('vaults.unreadTitle'))).toBeNull()
  })

  it('a retry that fails again is said again and takes focus', async () => {
    listVaults.mockRejectedValue(new Error('storage closed'))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: en('read.retry') }))
    await waitFor(() => expect(document.activeElement?.classList.contains('read-state')).toBe(true))
  })

  it('an empty storage still says "No vaults yet"', async () => {
    listVaults.mockResolvedValue([])
    mount()
    expect(await screen.findByText(en('vaults.empty'))).toBeTruthy()
    expect(screen.queryByText(en('vaults.unreadTitle'))).toBeNull()
  })

  it('a local Konclave that answers its health check and then not the list says what is missing', async () => {
    listVaults.mockResolvedValue([saved])
    health.mockResolvedValue(true)
    mount()
    expect(await screen.findByText('Treasury')).toBeTruthy()
    const text = said()!.textContent
    expect(text).toContain(en('vaults.unreadBridgeTitle'))
    expect(text).toContain(en('vaults.unreadBridgeHolds'))
    // the rows on screen were read just now: never "showing the last read"
    expect(text).not.toContain(en('read.stale'))
    expect(screen.queryByText(en('vaults.empty'))).toBeNull()
  })

  it('on the web, where there is no local Konclave to list, nothing is said to have failed', async () => {
    net.on = true
    listVaults.mockResolvedValue([saved])
    health.mockResolvedValue(true) // on the web this is the vault's server answering
    mount()
    expect(await screen.findByText('Treasury')).toBeTruthy()
    expect(said()).toBeNull()
    expect(getVaults).not.toHaveBeenCalled()
  })
})
