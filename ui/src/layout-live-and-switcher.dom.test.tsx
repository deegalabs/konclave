// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

/* #320: the offline pill sat inside a live region and carried its own role="status", so a reader
 * announced it twice; and when the on-device vault list could not be read, the switcher opened
 * empty and said nothing. The real Layout; the network, the signer and the decoration are fakes. */

const health = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health, getVault }))
vi.mock('./VaultSigner', () => ({ VaultSignerProvider: ({ children }: { children: ReactNode }) => children, useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./screens/SigningPanel', () => ({ default: () => null }))
vi.mock('./UpdatePrompt', () => ({ VersionBadge: () => null, UpdatePrompt: () => null }))
vi.mock('./AppPrefs', () => ({ default: () => null }))

const { default: Layout } = await import('./Layout')

const vault = { id: 'v1', name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Ana' }, { name: 'Bia' }], group_pubkey: 'v1', orchard_address: 'u1x', locked: false }
const mount = () => render(
  <MemoryRouter initialEntries={['/dashboard']}><I18nProvider>
    <Routes><Route element={<Layout />}><Route path="/dashboard" element={<div />} /></Route></Routes>
  </I18nProvider></MemoryRouter>,
)
const openSwitcher = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Caixa/ }))
  await screen.findByRole('menu')
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('konclave.locale', 'en')
  health.mockResolvedValue(true)
  getVault.mockResolvedValue(vault)
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('the offline status is announced once (#320)', () => {
  it('has exactly one live region, and the offline pill adds no second one', async () => {
    health.mockResolvedValue(false)
    mount()
    await screen.findByText(/Offline/)
    const pill = screen.getByText(/Offline/)
    const regions = document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')
    expect(regions.length).toBe(1)
    expect(regions[0]?.contains(pill)).toBe(true)
    expect(pill.closest('[role="status"]')).toBeNull()
  })
})

// The real `readVaults`: jsdom has no IndexedDB, which is exactly the failure `listVaults` hid as [].
const useIdb = async () => { (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = (await import('fake-indexeddb')).indexedDB }
const noIdb = () => { delete (globalThis as { indexedDB?: unknown }).indexedDB }
const hint = () => screen.queryByText(en('vaults.unreadTitle'))

describe('the vault switcher says when it cannot read the saved vaults (#320)', () => {
  beforeEach(noIdb)
  afterEach(noIdb)
  it('shows the hint when storage cannot be read', async () => {
    mount()
    await openSwitcher()
    expect(await screen.findByText(en('vaults.unreadTitle'))).toBeTruthy()
  })
  it('shows no hint when the list is genuinely empty', async () => {
    await useIdb()
    mount()
    await openSwitcher()
    await new Promise((r) => setTimeout(r, 100))
    expect(hint()).toBeNull()
  })
  it('clears the hint after a later successful read', async () => {
    mount()
    const chip = await screen.findByRole('button', { name: /Caixa/ })
    fireEvent.click(chip)
    await screen.findByText(en('vaults.unreadTitle'))
    fireEvent.click(chip) // close
    await useIdb()
    fireEvent.click(chip) // reopen: this read succeeds
    await waitFor(() => expect(hint()).toBeNull())
  })
  it('puts the hint where menu navigation reaches it', async () => {
    mount()
    await openSwitcher()
    const item = await screen.findByRole('menuitem', { name: en('vaults.unreadTitle') })
    expect(item.getAttribute('aria-disabled')).toBe('true')
  })
})
