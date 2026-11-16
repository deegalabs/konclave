// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { readFileSync, readdirSync } from 'node:fs'
import { stripComments } from './source-scan'
const code = (f: string) => stripComments(f, readFileSync(f, 'utf8'))
const en = (k: string): string => dict[k] ?? k

// Delete on the /net restore row removed the vault at once, with no backup offered. It now opens the
// one removal dialog every screen uses (remove-vault-dialog.tsx), gated on the typed name.
const h = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn(async () => true), select: vi.fn() }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: h.list, storageAvailable: () => true }))
vi.mock('./remove-vault', () => ({ removeVaultFromDevice: h.remove, clearVaultTraces: vi.fn() }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), setSelectedVault: h.select }))
const NetVault = (await import('./screens/NetVault')).default

const GK = 'cd'.repeat(32)
const rec = (over: object = {}) => ({ id: GK, name: 'Family', governance: 'quorum', myName: 'A', creatorName: 'A', groupKey: GK, address: '', roster: ['A', 'B'], createdAt: 1, threshold: 2, total: 2, cp: 3, ...over })
const show = () => render(<MemoryRouter><I18nProvider><Routes><Route path="/" element={<NetVault />} /><Route path="/settings" element={<p>settings page</p>} /></Routes></I18nProvider></MemoryRouter>)
const openConfirm = async () => {
  show()
  fireEvent.click(await screen.findByRole('button', { name: en('net.persist.deleteBtn') }))
  await screen.findByRole('dialog')
}
const field = () => screen.getByLabelText(/Type the vault name/) as HTMLInputElement
const danger = () => screen.getByRole('button', { name: en('dashboard.deletePermanently') }) as HTMLButtonElement
const type = (v: string) => fireEvent.change(field(), { target: { value: v } })

describe('Delete on the /net restore row', () => {
  beforeEach(() => { h.list.mockResolvedValue([rec()]); h.remove.mockReset(); h.remove.mockResolvedValue(true); h.select.mockClear() })
  afterEach(cleanup)

  it('clicking Delete does not delete', async () => {
    await openConfirm()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('says the seat is lost here without a backup, and offers Export first', async () => {
    await openConfirm()
    expect(screen.getByRole('dialog').textContent).toContain('lose access to that money')
    fireEvent.click(screen.getByRole('button', { name: en('dashboard.deleteBackupFirst') }))
    expect(h.select).toHaveBeenCalledWith(GK)
    await screen.findByText('settings page')
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('the dialog opens on the card: neither button has focus (fails without focusCard)', async () => {
    await openConfirm()
    const dlg = screen.getByRole('dialog')
    expect(danger().className).toContain('danger')
    expect(document.activeElement).not.toBe(danger())
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: en('dashboard.deleteBackupFirst') }))
    expect(document.activeElement).not.toBe(field())
    expect(dlg.contains(document.activeElement)).toBe(true)
  })

  it('the name is in the label, not the placeholder, and the button waits for it', async () => {
    await openConfirm()
    expect(field().placeholder).toBe('')
    expect(danger().disabled).toBe(true)
    type('Famil')
    expect(danger().disabled).toBe(true)
    type('Family')
    expect(danger().disabled).toBe(false)
  })

  it('Shift+Tab then Enter cannot delete without the name', async () => {
    await openConfirm()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    // Focus lands on the last ENABLED control; the disabled destructive button is skipped.
    expect(document.activeElement).not.toBe(danger())
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' })
    ;(document.activeElement as HTMLElement).click()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('confirming with the name deletes, and the dialog closes', async () => {
    await openConfirm()
    type('Family')
    fireEvent.click(danger())
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith(GK))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('focus goes to the restore card after a delete, not the page body', async () => {
    await openConfirm()
    type('Family')
    fireEvent.click(danger())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(document.activeElement?.id).toBe('net-restore-title')
  })

  it('a failed removal says so and keeps the dialog open', async () => {
    h.remove.mockResolvedValue(false)
    await openConfirm()
    type('Family')
    fireEvent.click(danger())
    expect((await screen.findByRole('alert')).textContent).toBe(en('settings.removeFail'))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('cancel keeps the vault', async () => {
    await openConfirm()
    fireEvent.click(screen.getByRole('button', { name: en('common.cancel') }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(h.remove).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: en('net.persist.deleteBtn') })).toBeTruthy()
  })

  it('a vault with no name is titled and gated by its short id', async () => {
    h.list.mockResolvedValue([rec({ name: undefined })])
    await openConfirm()
    const short = GK.slice(0, 8)
    expect(screen.getByRole('dialog').textContent).toContain(short)
    type(short)
    expect(danger().disabled).toBe(false)
    expect(screen.getByRole('dialog').querySelector('h2')?.textContent).not.toContain('“”')
  })
})

describe('one implementation of the removal confirm', () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'i18n' || e.name === 'node_modules' ? [] : walk(`${d}/${e.name}`)) : [`${d}/${e.name}`])
  it('only the shared dialog uses the destructive label and the title', () => {
    const users = walk('src').filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
      .filter((f) => /dashboard\.(deletePermanently|deleteConfirmTitle)/.test(code(f)))
    expect(users).toEqual(['src/remove-vault-dialog.tsx'])
  })
  it('all three screens render it', () => {
    for (const f of ['Vaults', 'Settings', 'NetVault']) expect(code(`src/screens/${f}.tsx`)).toMatch(/<RemoveVaultDialog/)
  })
})
