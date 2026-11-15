// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
import { StorageError } from './storage-errors'
const en = (k: string): string => dict[k] ?? k

// Rotating the passphrase: while the device verifies and seals, the three fields are locked (what is
// sealed is what was typed at the press), and the dialog cannot be left by Cancel, Esc, the backdrop
// or "Export first", because the rotation finishes either way and would then report on a closed
// dialog. NOTE: fireEvent.change ignores readOnly (measured), so this asserts the ATTRIBUTE and the
// arguments of the call, not that typing is refused by a browser.
const change = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Treasury', threshold: 2, total: 2, member_list: [] }),
  getSelectedVault: () => 'v',
}))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => [{ id: 'v', name: 'Treasury', governance: 'quorum', myName: 'Ana', groupKey: 'ab'.repeat(32), roster: ['Ana', 'Bia'], secured: true }],
  changePassphrase: (...a: unknown[]) => change.fn(...a),
}))
const { default: Settings } = await import('./screens/Settings')

const open = async () => {
  render(<MemoryRouter><I18nProvider><ToastProvider><Settings /></ToastProvider></I18nProvider></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: en('rotate.open') }))
  const f = (k: string) => screen.getByLabelText(en(k)) as HTMLInputElement
  fireEvent.change(f('rotate.currentLabel'), { target: { value: 'old passphrase 123' } })
  fireEvent.change(f('rotate.newLabel'), { target: { value: 'correct horse battery staple' } })
  fireEvent.change(f('rotate.new2Label'), { target: { value: 'correct horse battery staple' } })
  return f
}
const press = () => act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en('rotate.confirm') })) })

describe('rotation locks while it verifies', () => {
  beforeEach(() => { localStorage.setItem('konclave.locale', 'en'); change.fn.mockReset() })
  afterEach(() => cleanup())

  it('the three fields are read-only with no generator while pending, and editable after a failure, focus on the button', async () => {
    let reject!: (e: unknown) => void
    change.fn.mockImplementation(() => new Promise((_, r) => { reject = r }))
    const f = await open()
    await press()
    expect(change.fn).toHaveBeenCalledTimes(1)
    expect(change.fn).toHaveBeenCalledWith('v', 'old passphrase 123', 'correct horse battery staple')
    for (const k of ['rotate.currentLabel', 'rotate.newLabel', 'rotate.new2Label']) expect(f(k).readOnly, k).toBe(true)
    expect(document.querySelector('.pf-gen')).toBeNull()
    await act(async () => { reject(new Error('nope')) })
    await waitFor(() => expect(f('rotate.newLabel').readOnly).toBe(false))
    expect(f('rotate.currentLabel').readOnly).toBe(false)
    expect(document.activeElement).toBe(within(screen.getByRole('dialog')).getByRole('button', { name: en('rotate.confirm') }))
  })

  it('Cancel, Escape, the backdrop and "Export first" do not leave while it is pending', async () => {
    change.fn.mockImplementation(() => new Promise(() => {}))
    await open()
    await press()
    const dlg = () => screen.queryByRole('dialog')
    expect((within(dlg()!).getByRole('button', { name: en('common.cancel') }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dlg()!).getByRole('button', { name: en('common.cancel') }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.keyDown(dlg()!, { key: 'Escape' })
    fireEvent.click(dlg()!.parentElement!)
    fireEvent.click(within(dlg()!).getByRole('button', { name: en('rotate.exportFirst') }))
    expect(dlg()).not.toBeNull()
    expect(document.getElementById('xp-title')).toBeNull()
    expect(screen.getByLabelText(en('rotate.newLabel'))).toBeTruthy()
  })

  it('a failure is the description of the confirm button, and invalid is on the field at fault', async () => {
    const f = await open()
    fireEvent.change(f('rotate.new2Label'), { target: { value: 'something else entirely' } })
    await press()
    const btn = within(screen.getByRole('dialog')).getByRole('button', { name: en('rotate.confirm') })
    const err = document.getElementById('rot-err')!
    expect(err.textContent).toBe(en('rotate.errMismatch'))
    expect(btn.getAttribute('aria-describedby')).toBe('rot-err')
    expect(f('rotate.new2Label').getAttribute('aria-invalid')).toBe('true')
    expect(f('rotate.currentLabel').getAttribute('aria-invalid')).toBeNull()
    expect(f('rotate.newLabel').getAttribute('aria-invalid')).toBeNull()
    // a wrong current passphrase marks the current field
    fireEvent.change(f('rotate.new2Label'), { target: { value: 'correct horse battery staple' } })
    change.fn.mockRejectedValue(new StorageError('wrong-passphrase-saved', 'x'))
    await press()
    expect(f('rotate.currentLabel').getAttribute('aria-invalid')).toBe('true')
    expect(f('rotate.new2Label').getAttribute('aria-invalid')).toBeNull()
    // typing clears the error and the description
    fireEvent.change(f('rotate.currentLabel'), { target: { value: 'x' } })
    expect(btn.getAttribute('aria-describedby')).toBeNull()
  })

  it('a rotation that ends after Settings left still tells the member, through the toast', async () => {
    let resolve!: () => void
    change.fn.mockImplementation(() => new Promise<void>((r) => { resolve = r }))
    const view = render(<MemoryRouter><I18nProvider><ToastProvider><Settings /></ToastProvider></I18nProvider></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: en('rotate.open') }))
    const f = (k: string) => screen.getByLabelText(en(k)) as HTMLInputElement
    for (const [k, v] of [['rotate.currentLabel', 'old passphrase 123'], ['rotate.newLabel', 'correct horse battery staple'], ['rotate.new2Label', 'correct horse battery staple']] as const) fireEvent.change(f(k), { target: { value: v } })
    await press()
    // Settings goes away, the toast provider stays (it sits above the routes).
    view.rerender(<MemoryRouter><I18nProvider><ToastProvider><div /></ToastProvider></I18nProvider></MemoryRouter>)
    await act(async () => { resolve() })
    expect(await screen.findAllByText(en('rotate.done'))).not.toHaveLength(0)
  })

  it('without a pending rotation Cancel still closes', async () => {
    await open()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en('common.cancel') }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
