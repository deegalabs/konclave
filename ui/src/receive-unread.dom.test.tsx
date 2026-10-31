// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./toast', () => ({ useToast: () => ({ ok() {}, warn() {}, err() {}, info() {} }) }))
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { recordRead } from './read-failure'
const en = (k: string): string => dict[k] ?? k

// Receive said "No vault on this device" when the vault could not be read, which is false and
// sends a member to re-import a vault they hold. A failed read is now said, with a retry (#320).

const getVault = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getVault, getSelectedVault: () => 'v', IS_NET: false }))

const { default: Receive } = await import('./screens/Receive')

describe('the Receive screen says when the vault could not be read', () => {
  beforeEach(() => { localStorage.setItem('konclave.locale', 'en') })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('a failed read is said with its reason and a retry, never as "no vault on this device"', async () => {
    // By state, not by call count: the lock check asks for the vault too on this path.
    getVault.mockResolvedValue(null)
    recordRead('/api/vault', 'unavailable', 'bridge')
    render(<MemoryRouter><I18nProvider><Routes><Route element={<Outlet context={{ locked: false, unlockNonce: 0, live: true }} />}><Route path="/" element={<Receive />} /></Route></Routes></I18nProvider></MemoryRouter>)
    await screen.findByText(en('receive.unreadTitle'))
    expect(screen.queryByText(en('receive.noVault'))).toBeNull()
    recordRead('/api/vault', null)
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: 'v', orchard_address: 'u1' + 'q'.repeat(76) })
    fireEvent.click(screen.getByRole('button', { name: en('read.retry') }))
    await waitFor(() => expect(screen.queryByText(en('receive.unreadTitle'))).toBeNull()) // the vault arrived; the message left
  })
})
