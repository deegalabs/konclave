// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// The removal gate offers the export first (#309). Taking that shortcut leaves the gate the way
// Cancel does: disarmed, and with nothing typed in it, so coming back to remove starts over.
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Treasury', threshold: 2, total: 2, member_list: [] }),
  getSelectedVault: () => 'v',
}))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => [{ id: 'v', name: 'Treasury', governance: 'quorum', myName: 'Ana', groupKey: 'ab'.repeat(32), roster: ['Ana', 'Bia'], secured: true }],
}))
const { default: Settings } = await import('./screens/Settings')

const confirmField = () => screen.getByLabelText(en('set.confirmLabel').replace('{name}', 'Treasury')) as HTMLInputElement

describe('the export shortcut in the removal gate', () => {
  beforeEach(() => { localStorage.setItem('konclave.locale', 'en') })
  afterEach(() => cleanup())

  it('clears the typed name, so coming back to remove starts over', async () => {
    render(<MemoryRouter><I18nProvider><ToastProvider><Settings /></ToastProvider></I18nProvider></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: en('settings.remove') }))
    fireEvent.change(confirmField(), { target: { value: 'Treasury' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('set.removeExportFirst') })) })
    expect(screen.queryByRole('button', { name: en('settings.confirmRemove') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en('settings.remove') }))
    expect(confirmField().value).toBe('')
  })
})
