// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// Delete on the /net restore row removed the vault at once, with no backup offered (it destroyed a
// seat's only share on this device). It now asks first, with the app's own removal confirm copy.
const h = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(async () => true), select: vi.fn() }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: h.list, storageAvailable: () => true }))
vi.mock('./remove-vault', () => ({ removeVaultFromDevice: h.remove, clearVaultTraces: vi.fn() }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), setSelectedVault: h.select }))
const NetVault = (await import('./screens/NetVault')).default

const GK = 'cd'.repeat(32)
const rec = { id: GK, name: 'Family', governance: 'quorum', myName: 'A', creatorName: 'A', groupKey: GK, address: '', roster: ['A', 'B'], createdAt: 1, threshold: 2, total: 2, cp: 3 }
const show = () => render(<MemoryRouter><I18nProvider><NetVault /></I18nProvider></MemoryRouter>)
const openConfirm = async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: en('net.persist.deleteBtn') }))
}

describe('Delete on the /net restore row', () => {
  beforeEach(() => { h.list.mockResolvedValue([rec]); h.remove.mockClear(); h.select.mockClear() })
  afterEach(cleanup)

  it('clicking Delete does not delete', async () => {
    await openConfirm()
    await screen.findByRole('dialog')
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('says the seat is lost here without a backup, and offers Export first', async () => {
    await openConfirm()
    const dlg = await screen.findByRole('dialog')
    expect(dlg.textContent).toContain('lose access to that money')
    expect(screen.getByRole('button', { name: en('dashboard.deleteBackupFirst') })).toBeTruthy()
  })

  it('the confirm button is destructive and not focused on open', async () => {
    await openConfirm()
    const ok = await screen.findByRole('button', { name: en('dashboard.deletePermanently') })
    expect(ok.className).toContain('danger')
    expect(document.activeElement).not.toBe(ok)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('confirming deletes', async () => {
    await openConfirm()
    fireEvent.click(await screen.findByRole('button', { name: en('dashboard.deletePermanently') }))
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith(GK))
  })

  it('cancel keeps the vault', async () => {
    await openConfirm()
    fireEvent.click(await screen.findByRole('button', { name: en('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(h.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en('net.persist.deleteBtn') })).toBeTruthy()
  })
})
