// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { StorageError } from './storage-errors'
const en = (k: string): string => dict[k] ?? k

// #784: a device that imported a backup before the viewing key was sealed keeps the key in the
// clear until the passphrase is typed on it. A passkey unlock cannot do the rewrite, so a member who
// only uses a passkey kept the old record and nothing on screen said so. This mounts the notice
// against a storage whose record does and does not carry the clear field, and types the passphrase.
const hasClearViewingKey = vi.hoisted(() => vi.fn<(id: string) => Promise<boolean>>())
const loadVault = vi.hoisted(() => vi.fn<(id: string, pass: string) => Promise<unknown>>())
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), hasClearViewingKey, loadVault }))

const { default: ClearKeyNotice } = await import('./ClearKeyNotice')
const mount = (nonce = 0) => render(<I18nProvider><ClearKeyNotice vaultId="v1" unlockNonce={nonce} /></I18nProvider>)

describe('the notice about a viewing key still readable on this device (#784)', () => {
  beforeEach(() => { hasClearViewingKey.mockReset(); loadVault.mockReset() })
  afterEach(() => cleanup())

  it('shows while the record carries the clear field, and asks for the passphrase', async () => {
    hasClearViewingKey.mockResolvedValue(true)
    mount()
    const region = await screen.findByRole('region', { name: en('clearKey.title') })
    expect(region.textContent).toContain(en('clearKey.body'))
    expect(screen.getByLabelText(en('clearKey.passphrase'))).toBeTruthy()
    expect(hasClearViewingKey).toHaveBeenCalledWith('v1')
  })

  it('renders nothing when the record does not carry it', async () => {
    hasClearViewingKey.mockResolvedValue(false)
    const { container } = mount()
    await waitFor(() => expect(hasClearViewingKey).toHaveBeenCalled())
    expect(container.textContent).toBe('')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('typing the passphrase runs the rewrite and the notice goes away, saying it is done', async () => {
    hasClearViewingKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    loadVault.mockResolvedValue({})
    mount()
    await screen.findByRole('region')
    fireEvent.change(screen.getByLabelText(en('clearKey.passphrase')), { target: { value: 'correct horse' } })
    fireEvent.click(screen.getByRole('button', { name: en('clearKey.submit') }))
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
    expect(loadVault).toHaveBeenCalledWith('v1', 'correct horse')
    expect(screen.getByRole('status').textContent).toBe(en('clearKey.done'))
  })

  it('a wrong passphrase says so and keeps the notice, with the field cleared', async () => {
    hasClearViewingKey.mockResolvedValue(true)
    loadVault.mockRejectedValue(new StorageError('wrong-passphrase-saved', 'wrong'))
    mount()
    await screen.findByRole('region')
    const field = screen.getByLabelText(en('clearKey.passphrase')) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: en('clearKey.submit') }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(en('storage.err.wrongPassphraseSaved'))
    expect(screen.getByRole('region')).toBeTruthy()
    expect(field.value).toBe('')
  })

  it('checks again after an unlock, since a passphrase unlock does the rewrite on its own', async () => {
    hasClearViewingKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { rerender } = mount(0)
    await screen.findByRole('region')
    rerender(<I18nProvider><ClearKeyNotice vaultId="v1" unlockNonce={1} /></I18nProvider>)
    await waitFor(() => expect(screen.queryByRole('region')).toBeNull())
    expect(hasClearViewingKey).toHaveBeenCalledTimes(2)
  })
})
