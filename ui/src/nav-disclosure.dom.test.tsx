// @vitest-environment jsdom
// #317: the shell's "More" sheet and vault switcher are navigation, so they follow the disclosure
// pattern (a button that shows and hides a group of links), not the menu pattern they announced and
// did not implement. Escape closes either and returns focus to its button; focus leaving the pair
// closes it; choosing the item already current closes it too. The real Layout, the rest stood in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const VAULT = { id: 'v1', name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Ana', pubkey: 'Ana' }, { name: 'Bia', pubkey: 'Bia' }], group_pubkey: 'v1', orchard_address: '' }
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  getVault: async () => VAULT, health: async () => true, getSelectedVault: () => 'v1', isVaultUnlocked: () => true, setSelectedVault: () => {},
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [{ id: 'v1', name: 'Caixa' }, { id: 'v2', name: 'Outro' }] }))
vi.mock('./vault-lock', async (orig) => ({ ...(await orig<typeof import('./vault-lock')>()), needsUnlock: () => false, securedLocally: async () => false }))
vi.mock('./seat-registration', () => ({ useSeatRefusalCode: () => null }))
vi.mock('./usePoll', async (orig) => ({ ...(await orig<typeof import('./usePoll')>()), startVisiblePoll: () => () => {} }))
vi.mock('./VaultSigner', () => ({ VaultSignerProvider: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('./screens/SigningPanel', () => ({ default: () => null }))
vi.mock('./UpdatePrompt', () => ({ VersionBadge: () => null }))
vi.mock('./AppPrefs', () => ({ default: () => null }))
vi.mock('./LockOverlay', () => ({ default: () => null }))

const { default: Layout } = await import('./Layout')
const { I18nProvider } = await import('./i18n')

const mount = () => render(
  <MemoryRouter initialEntries={['/dashboard']}>
    <I18nProvider>
      <Routes><Route element={<Layout />}><Route path="*" element={<p>screen</p>} /></Route></Routes>
      <button type="button">outside</button>
    </I18nProvider>
  </MemoryRouter>,
)
const chip = () => document.querySelector('.rail-vault-chip') as HTMLButtonElement
const more = () => document.querySelector('.nav-more-btn') as HTMLButtonElement
const switcher = () => document.querySelector('.vault-pop') as HTMLElement | null
const sheet = () => document.querySelector('.nav-more-sheet') as HTMLElement | null

describe('the shell menus are disclosures that keep the keyboard where it was (#317)', () => {
  beforeEach(() => { localStorage.setItem('konclave.locale', 'en') })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('the vault switcher: a group, named and controlled; Escape closes it and returns focus to its button', async () => {
    mount()
    await waitFor(() => expect(chip().textContent).toContain('Caixa'))
    fireEvent.click(chip())
    const panel = await waitFor(() => { const p = switcher(); if (!p) throw new Error('closed'); return p })
    expect(panel.getAttribute('role')).toBe('group')
    expect(chip().getAttribute('aria-controls')).toBe(panel.id)
    expect(chip().getAttribute('aria-haspopup')).toBeNull()
    const row = await waitFor(() => { const r = panel.querySelector('button'); if (!r) throw new Error('no rows'); return r })
    row.focus()
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(switcher()).toBeNull()
    expect(document.activeElement).toBe(chip())
    expect(chip().getAttribute('aria-controls')).toBeNull()
  })

  it('the More sheet: Escape from inside closes it and returns focus to More', async () => {
    mount()
    fireEvent.click(more())
    const panel = sheet()!
    expect(panel.getAttribute('role')).toBe('group')
    expect(more().getAttribute('aria-controls')).toBe(panel.id)
    const link = panel.querySelector('a') as HTMLElement
    link.focus()
    fireEvent.keyDown(link, { key: 'Escape' })
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(more())
  })

  it('focus leaving the button and its panel closes the panel', async () => {
    mount()
    fireEvent.click(more())
    const link = sheet()!.querySelector('a') as HTMLElement
    link.focus()
    const outside = screen.getByRole('button', { name: 'outside' })
    act(() => { fireEvent.blur(link, { relatedTarget: outside }); outside.focus() })
    expect(sheet()).toBeNull()
  })

  it('choosing the vault already open closes the switcher and gives focus back to its button', async () => {
    mount()
    await waitFor(() => expect(chip().textContent).toContain('Caixa'))
    fireEvent.click(chip())
    const current = await waitFor(() => { const r = document.querySelector('.vault-pop-row.current') as HTMLElement | null; if (!r) throw new Error('no rows'); return r })
    fireEvent.click(current)
    expect(switcher()).toBeNull()
    expect(document.activeElement).toBe(chip())
  })

  it('announces no menu it does not implement', async () => {
    mount()
    fireEvent.click(more())
    fireEvent.click(chip())
    await waitFor(() => expect(switcher()).not.toBeNull())
    expect(document.querySelector('[role="menu"], [role="menuitem"]')).toBeNull()
  })
})
