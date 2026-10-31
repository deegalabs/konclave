// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// Staging warns in the export dialog when the backup is incomplete: the file restores the seat and
// not the vault. A successful download closed the dialog, which cleared that warning, and left
// "Download started" as the only notice. Mounted for real; only the backup builder, the download
// and the vault's reads are fakes, and the test reads what a member sees after each click.
const backup = vi.hoisted(() => ({ complete: false }))
const downloadText = vi.hoisted(() => vi.fn(() => true))
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
vi.mock('./build-backup', () => ({ buildVaultBackup: async () => ({ json: '{}', name: 'treasury.konclave.json', complete: backup.complete }) }))
vi.mock('./download', () => ({ downloadText }))
const { default: Settings } = await import('./screens/Settings')

const openAndType = async () => {
  render(<MemoryRouter><I18nProvider><ToastProvider><Settings /></ToastProvider></I18nProvider></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: en('export.open') }))
  fireEvent.change(screen.getByLabelText(en('export.currentLabel')), { target: { value: 'correct horse' } })
}
// The dialog's own buttons: the page has a "Copy" of its own beside the fingerprint.
const click = async (name: string) => { await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name })) }) }

describe('an incomplete backup keeps its warning (#771 review)', () => {
  beforeEach(() => { localStorage.setItem('konclave.locale', 'en'); downloadText.mockClear() })
  afterEach(() => cleanup())

  it('downloaded but incomplete: the dialog stays open with the warning, and no "Download started"', async () => {
    backup.complete = false
    await openAndType()
    await click(en('export.download'))
    expect(downloadText).toHaveBeenCalled()
    expect(screen.getByText(en('vaults.resumeBackupIncomplete'))).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByText(en('toast.backupSaved'))).toBeNull()
  })

  it('copied but incomplete: the same', async () => {
    backup.complete = false
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
    await openAndType()
    await click(en('export.copy'))
    expect(screen.getByText(en('vaults.resumeBackupIncomplete'))).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByText(en('toast.backupCopied'))).toBeNull()
  })

  it('a complete backup closes the dialog and says the download started', async () => {
    backup.complete = true
    await openAndType()
    await click(en('export.download'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    // The toast says it twice, on screen and in its live region.
    expect(screen.getAllByText(en('toast.backupSaved')).length).toBeGreaterThan(0)
  })
})
