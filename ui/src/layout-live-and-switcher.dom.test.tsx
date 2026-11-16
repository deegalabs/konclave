// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
const en = (k: string): string => dict[k] ?? k

/* #320: the offline pill sat inside a live region and carried its own role="status", so a reader
 * announced it twice; and when the on-device vault list could not be read, the switcher opened
 * empty and said nothing. The real Layout; the network, the signer and the decoration are fakes. */

const health = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const listVaults = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health, getVault }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults }))
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
  listVaults.mockResolvedValue([])
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

describe('the vault switcher says when it cannot read the saved vaults (#320)', () => {
  it('shows the hint when listing throws', async () => {
    listVaults.mockRejectedValue(new Error('idb'))
    mount()
    await openSwitcher()
    expect(await screen.findByText(en('nav.vaultsUnreadable'))).toBeTruthy()
  })
  it('shows no hint when the list is genuinely empty', async () => {
    mount()
    await openSwitcher()
    await waitFor(() => expect(listVaults).toHaveBeenCalled())
    expect(screen.queryByText(en('nav.vaultsUnreadable'))).toBeNull()
  })
  it('has the copy in both languages', () => {
    expect(dict['nav.vaultsUnreadable']).toBeTruthy()
    expect(ptBR['nav.vaultsUnreadable']).toBeTruthy()
  })
})
