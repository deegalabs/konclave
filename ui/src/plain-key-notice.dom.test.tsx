// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #784: a device that only unlocks with the passkey keeps a viewing key an old import left in the
// clear, because only the passphrase path (#781) can seal it. The vault list says so, once, on the
// card of that vault, and the notice goes away once the passphrase has run the rewrite.

const listVaults = vi.hoisted(() => vi.fn())
const loadVault = vi.hoisted(() => vi.fn())
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults, loadVault }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health: async () => false, getVaults: async () => [], isVaultUnlocked: () => false }))
vi.mock('./screens/NetVault', () => ({ default: () => null }))

const { default: Vaults } = await import('./screens/Vaults')
const { holdsPlainViewingKey } = await import('./plain-key')

const base = { governance: { threshold: 2, total: 2 }, threshold: 2, groupKey: 'g', address: 'u1x', roster: ['Alice', 'Bob'], createdAt: 1, secured: true }
const plain = { ...base, id: 'p', name: 'Plain', ufvk: 'uview1' + 'q'.repeat(40) }
const sealed = { ...base, id: 's', name: 'Sealed' }

const mount = () => render(<MemoryRouter initialEntries={['/vaults']}><I18nProvider><Vaults /></I18nProvider></MemoryRouter>)
const cardOf = (name: string) => screen.getByText(name).closest('.rd-card') as HTMLElement

describe('the notice for a viewing key still in the clear (#784)', () => {
  beforeEach(() => { localStorage.setItem('konclave.locale', 'en'); listVaults.mockResolvedValue([plain, sealed]); loadVault.mockReset() })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('reads presence only', () => {
    expect(holdsPlainViewingKey({ ufvk: 'u' })).toBe(true)
    expect(holdsPlainViewingKey({ ufvkCipher: new Uint8Array(1) })).toBe(false)
    expect(holdsPlainViewingKey(null)).toBe(false)
  })

  it('shows on the card with the plain field, not on the other, and never shows the value', async () => {
    mount()
    await screen.findByText('Plain')
    expect(within(cardOf('Plain')).getByText(en('vaults.plainKeyTitle'))).toBeTruthy()
    expect(within(cardOf('Sealed')).queryByText(en('vaults.plainKeyTitle'))).toBeNull()
    expect(document.body.textContent).not.toContain('uview1')
  })

  it('goes away after the passphrase ran the rewrite, and says when the passphrase was wrong', async () => {
    loadVault.mockRejectedValueOnce(new Error('wrong'))
    mount()
    await screen.findByText('Plain')
    const card = cardOf('Plain')
    fireEvent.change(within(card).getByLabelText(en('vaults.plainKeyPass')), { target: { value: 'nope' } })
    fireEvent.click(within(card).getByRole('button', { name: en('vaults.plainKeyBtn') }))
    expect(await within(card).findByText(en('vaults.plainKeyWrong'))).toBeTruthy()
    expect(within(card).getByText(en('vaults.plainKeyTitle'))).toBeTruthy()

    loadVault.mockResolvedValueOnce({})
    fireEvent.change(within(card).getByLabelText(en('vaults.plainKeyPass')), { target: { value: 'right' } })
    fireEvent.click(within(card).getByRole('button', { name: en('vaults.plainKeyBtn') }))
    await waitFor(() => expect(within(card).queryByText(en('vaults.plainKeyTitle'))).toBeNull())
    expect(loadVault).toHaveBeenLastCalledWith('p', 'right')
  })
})
