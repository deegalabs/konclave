// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #664: on desktop, "This device only" opened `/create`, the ceremony that needs the local bridge,
// and the desktop shell embeds no bridge until #212. The option was offered in TWO places, the create
// chooser on Vaults and the coordination row in Settings, so both screens are mounted here and both
// are read the way a member sees them. Only the shell detection and the vault reads are fakes.
const shell = vi.hoisted(() => ({ desktop: true }))
vi.mock('./platform', () => ({ get isDesktop() { return shell.desktop } }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => false,
  getVaults: async () => null,
  getVault: async () => ({ id: 'v', name: 'Treasury', threshold: 2, total: 2, member_list: [] }),
  getSelectedVault: () => 'v',
}))

const { default: Vaults } = await import('./screens/Vaults')
const { default: Settings } = await import('./screens/Settings')
const mount = (el: React.ReactElement) => render(<MemoryRouter><I18nProvider><ToastProvider>{el}</ToastProvider></I18nProvider></MemoryRouter>)
const DEVICE_ONLY = 'This device only'

describe('desktop does not offer the local-bridge path until #212 (#664)', () => {
  beforeEach(() => { shell.desktop = true; localStorage.clear(); localStorage.setItem('konclave.locale', 'en') })
  afterEach(() => cleanup())

  it('the create chooser on Vaults offers "Your server" and not "This device only"', async () => {
    mount(<Vaults />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en('vaults.doorCreate')) }))
    const chooser = screen.getByRole('dialog')
    expect(within(chooser).getByRole('button', { name: 'Your server' })).toBeTruthy()
    expect(within(chooser).queryByRole('button', { name: DEVICE_ONLY })).toBeNull()
  })

  it('the coordination row in Settings offers "Your server" and not "This device only"', async () => {
    mount(<Settings />)
    expect(await screen.findByRole('button', { name: en('settings.coordCustom') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en('settings.coordLocal') })).toBeNull()
  })
})
