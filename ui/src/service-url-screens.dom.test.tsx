// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
const en = (k: string, vars: Record<string, string> = {}): string =>
  (dict[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => vars[n] ?? `{${n}}`)

// #1067: the two screens that take a coordinator address (the create chooser on Vaults and the
// coordination row in Settings, desktop only) say why an address is refused, and a refused one is
// neither stored nor acted on: no vault is created and nothing reloads. Mounted as the member sees
// them, with only the shell detection and the vault reads faked (as in desktop-local-coord).
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
const PASSWORD = 'https://user:secret@coordinator.example'
// The page has other live regions (the toasts), so a message is found by its text, then its role.
const said = (text: string) => { const el = screen.getByText(text); expect(el.getAttribute('role')).toBe('alert'); return el }
const anyRefusal = () => Object.keys(dict).filter((k) => k.startsWith('serviceUrl.')).some((k) => screen.queryByText(dict[k] ?? k))

async function openOwnServer() {
  mount(<Vaults />)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(en('vaults.doorCreate')) }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Your server' }))
  return screen.getByPlaceholderText(en('vaults.chooseUrlPlaceholder'))
}

describe('the screens refuse an address through the one rule (#1067)', () => {
  beforeEach(() => { shell.desktop = true; localStorage.clear(); localStorage.setItem('konclave.locale', 'en') })
  afterEach(() => cleanup())

  it('Vaults: a refused address says why, and neither Enter nor Continue creates a vault or stores it', async () => {
    const field = await openOwnServer()
    fireEvent.change(field, { target: { value: PASSWORD } })
    said(en('serviceUrl.credentials'))
    const cont = screen.getByRole('button', { name: en('vaults.chooseContinue') }) as HTMLButtonElement
    expect(cont.disabled).toBe(true)
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.click(cont)
    expect(screen.getByRole('heading', { name: en('vaults.chooseTitle') })).toBeTruthy() // still on the chooser
    expect(localStorage.getItem('konclave.coord.url')).toBeNull()
    expect(localStorage.getItem('konclave.coord.mode')).toBeNull()
  })

  it('Vaults: a valid address is stored normalised and moves on', async () => {
    const field = await openOwnServer()
    fireEvent.change(field, { target: { value: 'https://Coordinator.example/' } })
    expect(anyRefusal()).toBe(false)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(localStorage.getItem('konclave.coord.url')).toBe('https://coordinator.example')
    expect(localStorage.getItem('konclave.coord.mode')).toBe('custom')
    expect(screen.queryByRole('heading', { name: en('vaults.chooseTitle') })).toBeNull()
  })

  it('Settings: a refused address says why and Save stays disabled', async () => {
    mount(<Settings />)
    fireEvent.click(await screen.findByRole('button', { name: en('settings.coordCustom') }))
    fireEvent.change(screen.getByPlaceholderText(en('settings.coordUrlPlaceholder')), { target: { value: 'https://coordinator.example/?a=1' } })
    said(en('serviceUrl.query'))
    expect((screen.getByRole('button', { name: en('settings.coordSave') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Settings: an address stored before the rule, now refused, is set aside without being shown back', async () => {
    localStorage.setItem('konclave.coord.mode', 'custom')
    localStorage.setItem('konclave.coord.url', PASSWORD)
    mount(<Settings />)
    const field = await screen.findByPlaceholderText(en('settings.coordUrlPlaceholder')) as HTMLInputElement
    expect(field.value).toBe('')
    said(en('serviceUrl.storedRefused', { reason: en('serviceUrl.credentials') }))
    expect(document.body.textContent).not.toContain('secret')
    expect(localStorage.getItem('konclave.coord.url')).toBe(PASSWORD) // kept until the member replaces it
  })
})
