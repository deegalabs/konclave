// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { I18nProvider } from './i18n'

// P0A. `Layout` decides the lock from the device's own record before it asks anyone about the vault,
// and mounts no screen while that is undecided or locked. The real Layout, the real store and the
// real session; the network, the signer and the shell's decoration are fakes, and the test reads
// whether the vault was named.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
const health = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const mounts = vi.hoisted(() => ({ n: 0, reads: 0 }))
// The unlock callback each overlay was given, by vault id: an unlock that resolves late calls the one it had.
const unlocks = vi.hoisted(() => ({} as Record<string, () => void>))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health, getVault }))
vi.mock('./VaultSigner', () => ({ VaultSignerProvider: ({ children }: { children: ReactNode }) => children, useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./screens/SigningPanel', () => ({ default: () => null }))
vi.mock('./UpdatePrompt', () => ({ VersionBadge: () => null, UpdatePrompt: () => null }))
vi.mock('./AppPrefs', () => ({ default: () => null }))
// The overlay's passphrase work is not what this reads: its button does what a good unlock does.
vi.mock('./LockOverlay', async () => {
  const { setReadSecret } = await import('./session')
  return { default: (p: { vaultId: string; vaultName: string; onUnlocked: () => void; onCancel: () => void }) => {
    unlocks[p.vaultId] = p.onUnlocked
    return (
    <div role="dialog">locked:{p.vaultName}<button onClick={() => p.onCancel()}>leave</button><button onClick={() => { setReadSecret(p.vaultId, new Uint8Array(32).fill(9)); p.onUnlocked() }}>unlock</button></div>
    ) } }
})

const { default: Layout } = await import('./Layout')
const { saveVault, deleteVault } = await import('./storage')
const { setSelectedVault } = await import('./api')
const { clearReadSecret } = await import('./session')
const { draftKey } = await import('./payroll-draft')

const ID = 'cd'.repeat(32)
const ID2 = 'ef'.repeat(32)
const vault = { id: ID, name: 'Treasury', threshold: 2, total: 2, members: 2, member_list: [], group_pubkey: ID, orchard_address: 'u1test' }
const save = (secret: boolean) => saveVault(ID, {
  name: 'Record Name', governance: 'quorum', myName: 'Ana', creatorName: 'Ana',
  groupKey: new Uint8Array(32).fill(0xcd), address: 'u1test', roster: ['Ana', 'Bia'],
  sealedShare: new Uint8Array(32).fill(1), ...(secret ? { accessSecret: new Uint8Array(32).fill(9) } : {}),
}, 'river stone maple lantern')

// A screen under the Outlet: it counts that it mounted, and reads the vault when it does.
function Probe() {
  useEffect(() => { mounts.n++; mounts.reads++; void getVault() }, [])
  return <p>screen</p>
}
const mount = () => render(
  <MemoryRouter initialEntries={['/dashboard']}><I18nProvider>
    <Routes><Route element={<Layout />}><Route path="/dashboard" element={<Probe />} /></Route><Route path="/vaults" element={<p>vaults page</p>} /></Routes>
  </I18nProvider></MemoryRouter>,
)
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)) })

beforeEach(() => {
  mounts.n = 0; mounts.reads = 0
  localStorage.setItem('konclave.locale', 'en')
  setSelectedVault(ID)
  health.mockResolvedValue(true)
  getVault.mockResolvedValue(vault)
})
afterEach(async () => { cleanup(); vi.clearAllMocks(); clearReadSecret(ID); clearReadSecret(ID2); await deleteVault(ID).catch(() => {}); await deleteVault(ID2).catch(() => {}); localStorage.removeItem(draftKey(ID)) })

describe('a protected vault this device holds is not named before it is unlocked (P0A)', () => {
  it('T6: locked from the record, no screen mounts, the vault is never asked for, the draft is cleared, the overlay names the record', async () => {
    await save(true)
    localStorage.setItem(draftKey(ID), JSON.stringify({ competencia: 'x', description: '', copiedFrom: null, rows: [] }))
    mount()
    await screen.findByText('locked:Record Name')
    await settle()
    expect(mounts.n).toBe(0)
    expect(getVault).not.toHaveBeenCalled()
    expect(localStorage.getItem(draftKey(ID))).toBeNull()
  })

  it('T6: a vault the coordinator must answer for (no record here) mounts no screen while that answer is pending', async () => {
    getVault.mockReturnValue(new Promise(() => {})) // undecided, and nothing on the device to decide from
    mount()
    await settle()
    expect(mounts.n).toBe(0)
    expect(screen.getByRole('status')).toBeTruthy() // not a blank pane
  })

  it('I2: a record that says open decides at once: a coordinator that never answers does not hold the screen', async () => {
    await save(false)
    health.mockReturnValue(new Promise(() => {}))
    mount()
    await screen.findByText('screen')
    expect(mounts.n).toBe(1)
  })

  it('T6: an open vault mounts its screen once the decision lands', async () => {
    await save(false)
    mount()
    await screen.findByText('screen')
    expect(mounts.n).toBe(1)
  })

  it('T2: the coordinator unreachable at load still reaches the overlay, and after the unlock the screen mounts and reads', async () => {
    await save(true)
    health.mockResolvedValue(false)
    mount()
    await screen.findByText('locked:Record Name')
    expect(getVault).not.toHaveBeenCalled()
    act(() => { screen.getByText('unlock').click() })
    await screen.findByText('screen')
    await waitFor(() => expect(getVault).toHaveBeenCalled())
  })

  it('T2: a coordinator that is down at load leaves an unlocked vault with its screen, not a blank', async () => {
    await save(false)
    health.mockResolvedValue(false)
    mount()
    await screen.findByText('screen')
  })

  it('F1: leaving the unlock screen mounts no screen on the way out and names the vault to nobody', async () => {
    await save(true)
    mount()
    await screen.findByText('locked:Record Name')
    act(() => { screen.getByText('leave').click() })
    await screen.findByText('vaults page')
    await settle()
    expect(mounts.n).toBe(0)
    expect(getVault).not.toHaveBeenCalled()
  })

  // A second vault on the device, protected and not unlocked in this session.
  const saveSecond = () => saveVault(ID2, {
    name: 'Other Vault', governance: 'quorum', myName: 'Ana', creatorName: 'Ana',
    groupKey: new Uint8Array(32).fill(0xef), address: 'u1other', roster: ['Ana', 'Bia'],
    sealedShare: new Uint8Array(32).fill(1), accessSecret: new Uint8Array(32).fill(8),
  }, 'river stone maple lantern')
  const named = (id: string) => getVault.mock.calls.length > 0 && localStorage.getItem('konclave.selectedVault') === id

  it('F2: switching from the rail to a protected vault that is not unlocked mounts no screen and asks for no vault', async () => {
    await save(false)
    await saveSecond()
    mount()
    await screen.findByText('screen')
    await settle()
    getVault.mockClear()
    const mountsBefore = mounts.n
    act(() => { screen.getByText('Treasury').click() })
    const row = await screen.findByText('Other Vault')
    act(() => { row.click() })
    await settle()
    expect(mounts.n).toBe(mountsBefore)
    expect(getVault).not.toHaveBeenCalled()
    expect(named(ID2)).toBe(false)
  })

  it('F3: a selection another tab changed to a locked vault is decided again, and mounts no screen for it', async () => {
    await save(false)
    await saveSecond()
    mount()
    await screen.findByText('screen')
    await settle()
    getVault.mockClear()
    const mountsBefore = mounts.n
    localStorage.setItem('konclave.selectedVault', ID2)
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'konclave.selectedVault', newValue: ID2 })) })
    await screen.findByText('locked:Other Vault')
    await settle()
    expect(mounts.n).toBe(mountsBefore)
    expect(getVault).not.toHaveBeenCalled()
  })

  it('M2/M4: while locked the rail names the vault and says Locked, and the app behind the overlay is inert', async () => {
    await save(true)
    const { container } = mount()
    await screen.findByText('locked:Record Name')
    expect(container.querySelector('.rv-name')?.textContent).toBe('Record Name')
    expect(container.querySelector('.rv-q')?.textContent).toBe('Locked')
    expect(container.querySelector('.applayout')?.hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('dialog').closest('.applayout')).toBeNull() // the overlay is not inside what is inert
    act(() => { screen.getByText('unlock').click() })
    await screen.findByText('screen')
    expect(container.querySelector('.applayout')?.hasAttribute('inert')).toBe(false)
  })

  it('L2: a vault read that fails after the unlock leaves no unhandled rejection', async () => {
    await save(true)
    const seen: unknown[] = []
    const onRej = (e: unknown) => { seen.push(e) }
    process.on('unhandledRejection', onRej)
    mount()
    await screen.findByText('locked:Record Name')
    getVault.mockRejectedValue(new Error('coordinator down'))
    act(() => { screen.getByText('unlock').click() })
    await settle(); await settle()
    process.off('unhandledRejection', onRej)
    expect(seen).toEqual([])
  })

  it('R2-I1: A locked, another tab goes to B (undecided) and back to A: A is locked again and no screen mounts', async () => {
    await save(true)
    mount()
    await screen.findByText('locked:Record Name')
    getVault.mockReturnValue(new Promise(() => {})) // B has no record here and its answer never lands
    const sel = (id: string) => {
      localStorage.setItem('konclave.selectedVault', id)
      act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'konclave.selectedVault', newValue: id })) })
    }
    sel(ID2); await settle()
    sel(ID); await settle()
    expect(mounts.n).toBe(0)
    expect(getVault).not.toHaveBeenCalledWith(ID)
    await screen.findByText('locked:Record Name')
  })

  it('G1: an unlock of A that lands after the selection moved to B leaves B locked and names B to nobody', async () => {
    await save(true)
    await saveSecond()
    mount()
    await screen.findByText('locked:Record Name')
    const lateUnlockOfA = unlocks[ID]!
    localStorage.setItem('konclave.selectedVault', ID2)
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'konclave.selectedVault', newValue: ID2 })) })
    await screen.findByText('locked:Other Vault')
    getVault.mockClear()
    act(() => { lateUnlockOfA() })
    await settle()
    expect(mounts.n).toBe(0)
    expect(screen.getByText('locked:Other Vault')).toBeTruthy()
    expect(getVault).not.toHaveBeenCalled()
  })

  it('R2-M1: a rail read that lands after the selection moved does not name the old vault', async () => {
    await save(true)
    mount()
    await screen.findByText('locked:Record Name')
    let land!: (v: typeof vault) => void
    getVault.mockReturnValueOnce(new Promise((r) => { land = r })) // A's rail read, pending
    getVault.mockReturnValue(new Promise(() => {})) // B (no record here) never answers
    act(() => { screen.getByText('unlock').click() })
    localStorage.setItem('konclave.selectedVault', ID2)
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'konclave.selectedVault', newValue: ID2 })) })
    await settle()
    await act(async () => { land(vault); await new Promise((r) => setTimeout(r, 30)) })
    expect(document.querySelector('.rv-name')?.textContent ?? '').not.toBe('Treasury')
  })
})
