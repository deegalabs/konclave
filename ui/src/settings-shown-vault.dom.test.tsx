// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { en as dict } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
const en = (k: string): string => dict[k] ?? k

// Settings acts on the vault it SHOWS. The selection is real localStorage, moved the way another tab
// moves it; each refusal asserts its sentence, and each has a positive pair with the same inputs, so
// a disabled button can never stand in for the guard.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.locale', 'en')
const spies = vi.hoisted(() => ({
  change: vi.fn(async (..._a: unknown[]) => {}), backup: vi.fn(async (..._a: unknown[]) => ({ json: '{}', name: 'b.konclave.json', complete: true })),
  download: vi.fn(() => true), enrol: vi.fn(async (..._a: unknown[]) => ({ credentialId: new Uint8Array([1]), salt: new Uint8Array([2]), iv: new Uint8Array([3]), cipher: new Uint8Array([4]) })),
  remove: vi.fn(async (..._a: unknown[]) => true),
  gate: { release: () => {}, wait: null as Promise<void> | null, healthy: true },
}))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => { if (spies.gate.wait) await spies.gate.wait; return spies.gate.healthy },
  getVault: async () => {
    const id = localStorage.getItem('konclave.selectedVault')
    return id ? { id, name: `Treasury ${id}`, threshold: 2, total: 2, member_list: [] } : null
  },
}))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  changePassphrase: spies.change,
  listVaults: async () => ['X', 'Y'].map((id) => ({ id, name: `Treasury ${id}`, governance: 'quorum', myName: 'Ana', groupKey: id.toLowerCase().repeat(32), roster: ['Ana', 'Bia'], secured: true })),
}))
vi.mock('./remove-vault', async (orig) => ({ ...(await orig<typeof import('./remove-vault')>()), removeVaultFromDevice: spies.remove }))
vi.mock('./build-backup', () => ({ buildVaultBackup: spies.backup }))
vi.mock('./download', () => ({ downloadText: spies.download }))
vi.mock('./prf-wrap', async (orig) => ({ ...(await orig<typeof import('./prf-wrap')>()), enrolPrf: spies.enrol }))
vi.mock('./session', async (orig) => ({ ...(await orig<typeof import('./session')>()), readSecretFor: () => new Uint8Array(32) }))
const { default: Settings } = await import('./screens/Settings')
const { I18nProvider } = await import('./i18n')
const { ToastProvider } = await import('./toast')

const SEL = 'konclave.selectedVault'
const NEW = 'correct horse battery staple 9'
const tree = () => <MemoryRouter><I18nProvider><ToastProvider><Settings /></ToastProvider></I18nProvider></MemoryRouter>
const dialog = () => within(screen.getByRole('dialog'))
const type = (label: string, v: string) => fireEvent.change(dialog().getByLabelText(label), { target: { value: v } })
async function openRotate() {
  fireEvent.click(await screen.findByRole('button', { name: en('rotate.open') }))
}
const fillRotate = () => { type(en('rotate.currentLabel'), 'old word'); type(en('rotate.newLabel'), NEW); type(en('rotate.new2Label'), NEW) }
const confirmRotate = () => act(async () => { fireEvent.click(dialog().getByRole('button', { name: en('rotate.confirm') })) })
const otherTab = (id: string | null) => { if (id) localStorage.setItem(SEL, id); else localStorage.removeItem(SEL) }
const prf = (id: string) => localStorage.getItem(`konclave.prf.${id}`)

beforeEach(() => {
  localStorage.setItem(SEL, 'X'); localStorage.removeItem('konclave.prf.X'); localStorage.removeItem('konclave.prf.Y')
  Object.values(spies).forEach((s) => typeof s === 'function' && (s as ReturnType<typeof vi.fn>).mockClear())
  spies.gate.wait = null; spies.gate.healthy = true
  Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true })
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
})
afterEach(() => cleanup())

describe('changing the passphrase acts on the shown vault', () => {
  it('T4 the pair: with no switch it is called once for X with the typed words', async () => {
    render(tree()); await openRotate(); fillRotate(); await confirmRotate()
    expect(spies.change).toHaveBeenCalledTimes(1)
    expect(spies.change).toHaveBeenCalledWith('X', 'old word', NEW)
  })
  it('T2 the selection moved, THEN the fields were typed: nothing is changed, and it says why', async () => {
    render(tree()); await openRotate(); otherTab('Y'); fillRotate(); await confirmRotate()
    expect(spies.change).not.toHaveBeenCalled()
    expect(screen.getByText(en('settings.vaultChanged'))).toBeTruthy()
  })
  it('T3 typed, THEN the selection moved (no re-render): the same', async () => {
    render(tree()); await openRotate(); fillRotate(); otherTab('Y'); await confirmRotate()
    expect(spies.change).not.toHaveBeenCalled()
    expect(screen.getByText(en('settings.vaultChanged'))).toBeTruthy()
  })
  it('T9 the vault was removed in another tab: it says it is gone', async () => {
    render(tree()); await openRotate(); fillRotate(); otherTab(null); await confirmRotate()
    expect(spies.change).not.toHaveBeenCalled()
    expect(screen.getByText(en('settings.vaultGone'))).toBeTruthy()
  })
})

describe('exporting acts on the shown vault', () => {
  const open = async () => { render(tree()); fireEvent.click(await screen.findByRole('button', { name: en('export.open') })); type(en('export.currentLabel'), 'old word') }
  const click = (name: string) => act(async () => { fireEvent.click(dialog().getByRole('button', { name })) })
  it('T6 the pair: download and copy build the backup of X', async () => {
    await open(); await click(en('export.download'))
    expect(spies.backup).toHaveBeenCalledTimes(1)
    expect(spies.backup.mock.calls[0]![0]).toBe('X')
  })
  it('T5 the selection moved: neither download nor copy builds anything, and the sentence is shown', async () => {
    await open(); otherTab('Y')
    await click(en('export.download'))
    expect(screen.getByText(en('settings.vaultChanged'))).toBeTruthy()
    await click(en('export.copy'))
    expect(spies.backup).not.toHaveBeenCalled()
    expect(spies.download).not.toHaveBeenCalled()
    expect(screen.queryByText(en('toast.backupSaved'))).toBeNull()
  })
})

describe('the passkey shortcut acts on the shown vault', () => {
  const key = () => screen.findByRole('button', { name: en('set.passkeyOn') })
  it('the pair: with no switch it is created for X', async () => {
    const { rerender } = render(tree()); rerender(tree())
    const b = await key()
    await act(async () => { fireEvent.click(b) })
    expect(spies.enrol).toHaveBeenCalledTimes(1)
    expect(spies.enrol.mock.calls[0]![1]).toBe('X')
    await waitFor(() => expect(prf('X')).not.toBeNull())
  })
  it('T7 the selection moved and the screen re-rendered: nothing is created for Y', async () => {
    const { rerender } = render(tree()); const b = await key()
    otherTab('Y'); rerender(tree())
    await act(async () => { fireEvent.click(b) })
    expect(spies.enrol).not.toHaveBeenCalled()
    expect(prf('Y')).toBeNull()
    expect(screen.getByText(en('settings.vaultChanged'))).toBeTruthy()
  })
  it('T8 removing it, same switch: both wraps stay, and the sentence is shown', async () => {
    const wrap = JSON.stringify({ credentialId: 'AQ', salt: 'Ag', iv: 'Aw', cipher: 'BA' })
    localStorage.setItem('konclave.prf.X', wrap); localStorage.setItem('konclave.prf.Y', wrap)
    const { rerender } = render(tree()); const b = await screen.findByRole('button', { name: en('set.passkeyOff') })
    otherTab('Y'); rerender(tree())
    fireEvent.click(await screen.findByRole('button', { name: en('set.passkeyOff') }))
    expect(prf('X')).not.toBeNull(); expect(prf('Y')).not.toBeNull()
    expect(screen.getByText(en('settings.vaultChanged'))).toBeTruthy()
    expect(b).toBeTruthy()
  })
  it('T8 the pair: removing it with no switch drops the wrap of X only', async () => {
    const wrap = JSON.stringify({ credentialId: 'AQ', salt: 'Ag', iv: 'Aw', cipher: 'BA' })
    localStorage.setItem('konclave.prf.X', wrap); localStorage.setItem('konclave.prf.Y', wrap)
    render(tree())
    fireEvent.click(await screen.findByRole('button', { name: en('set.passkeyOff') }))
    expect(prf('X')).toBeNull(); expect(prf('Y')).not.toBeNull()
  })
})

describe('the screen is mounted on the vault that was selected when it opened (T10)', () => {
  it('a switch during the first read does not turn the screen into the other vault', async () => {
    let release!: () => void
    spies.gate.wait = new Promise<void>((r) => { release = r })
    render(tree())
    otherTab('Y'); release()
    await waitFor(() => expect(document.body.textContent).toContain(en('set.readRow')))
    expect(screen.queryByText('Treasury Y')).toBeNull()
  })
  // L3: the answer was dropped because it was about another vault; saying the device keeps nothing of
  // THIS vault would be false. The danger zone says what is true instead.
  it('the danger zone does not claim the device holds nothing', async () => {
    let release!: () => void
    spies.gate.wait = new Promise<void>((r) => { release = r })
    render(tree())
    otherTab('Y'); release()
    expect(await screen.findAllByText(en('settings.vaultChanged'))).toBeTruthy()
    expect(screen.queryByText(en('settings.removeNoLocal'))).toBeNull()
  })
})

describe('removing from this device acts on the shown vault', () => {
  async function arm() {
    render(tree())
    fireEvent.click(await screen.findByRole('button', { name: en('settings.remove') }))
    // The removal dialog (#1025): the name is typed into the field its label names.
    const dialog = within(await screen.findByRole('dialog'))
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Treasury X' } })
    return dialog.getByRole('button', { name: en('dashboard.deletePermanently') })
  }
  it('the pair: with no switch it removes X', async () => {
    const b = await arm(); await act(async () => { fireEvent.click(b) })
    expect(spies.remove).toHaveBeenCalledTimes(1)
    expect(spies.remove).toHaveBeenCalledWith('X')
  })
  it('the selection was cleared: nothing is removed, and the sentence is shown', async () => {
    const b = await arm(); otherTab(null); await act(async () => { fireEvent.click(b) })
    expect(spies.remove).not.toHaveBeenCalled()
    expect(screen.getByText(en('settings.vaultGone'))).toBeTruthy()
  })
  it('the selection moved: nothing is removed, and the sentence is shown', async () => {
    const b = await arm(); otherTab('Y'); await act(async () => { fireEvent.click(b) })
    expect(spies.remove).not.toHaveBeenCalled()
    expect(screen.getByText(en('settings.vaultChanged'))).toBeTruthy()
  })
})

// L1: no selection says only what is known, not that the vault was removed.
describe('the sentence for a cleared selection is true in every case', () => {
  it.each([['en', dict], ['pt-BR', ptBR as Record<string, string>]])('%s does not say the vault was removed', (_l, d) => {
    for (const k of ['settings.vaultGone', 'payment.vaultGone']) {
      expect(d[k], k).toBeTruthy()
      expect(d[k], k).not.toMatch(/removed|removido/i)
    }
  })
  // One mapping from a refusal to its sentence (shown-vault.ts), so a second copy cannot drift again.
  it('only shown-vault.ts names the two sentences', () => {
    for (const f of ['screens/Settings.tsx', 'remove-vault-dialog.tsx', 'api.ts']) {
      expect(codeOf(f), f).not.toMatch(/vaultGone|vaultChanged/)
    }
    expect(codeOf('shown-vault.ts')).toMatch(/vaultGone/)
  })
})

// L2: with the coordinator down there is no `vault`, and the passkey shortcut (local) still works,
// because the id it acts on is the pinned one.
describe('the pinned id carries the passkey row when the coordinator is down', () => {
  it('shows the remove-passkey button and removes the wrap of the pinned vault', async () => {
    spies.gate.healthy = false
    const wrap = JSON.stringify({ credentialId: 'AQ', salt: 'Ag', iv: 'Aw', cipher: 'BA' })
    localStorage.setItem('konclave.prf.X', wrap)
    render(tree())
    fireEvent.click(await screen.findByRole('button', { name: en('set.passkeyOff') }))
    expect(prf('X')).toBeNull()
  })
})
