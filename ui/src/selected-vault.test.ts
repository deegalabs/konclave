import { beforeEach, describe, expect, it, vi } from 'vitest'

// #610 review. Everything the signer keys on - which share it opens, which signing room it joins,
// which device record the money gate reads the vault's own receivers from, which vault the send
// names - came from `getVault()`, and `getVault()` returned the vault id the COORDINATOR answered
// with, not the one the member had opened. A coordinator that answered with another vault on the
// same device moved the whole ceremony onto it: that vault's quorum would sign the open proposal's
// lines without ever approving them. The answer must be about the vault that was asked for.

const storage = vi.hoisted(() => ({
  listVaults: vi.fn(async () => [] as { id: string; address?: string }[]),
  updateVaultMeta: vi.fn(async () => {}),
  recordChangeReceiver: vi.fn(async () => true),
}))
vi.mock('./storage', async (importOriginal) => ({ ...(await importOriginal<typeof import('./storage')>()), ...storage }))

const opened = 'aa'.repeat(32)
const other = 'bb'.repeat(32)
let answer: Record<string, unknown> = {}

const mem = new Map<string, string>()
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.setItem) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
}
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.selectedVault', opened)
vi.stubGlobal('fetch', async (url: string) =>
  String(url).includes('/api/vault?')
    ? new Response(JSON.stringify({ vault: answer }), { status: 200 })
    : new Response('{}', { status: 404 }),
)
const api = await import('./api')

describe('getVault answers for the vault the member opened', () => {
  beforeEach(() => {
    storage.listVaults.mockClear()
    storage.updateVaultMeta.mockClear()
    storage.recordChangeReceiver.mockClear()
    storage.listVaults.mockResolvedValue([{ id: opened, address: '' }])
  })

  it('exercises the hosted path', () => {
    expect(api.IS_NET).toBe(true)
  })

  it('takes an answer about the vault that was asked for, keyed by that vault', async () => {
    answer = { vault_id: opened, address: 'u1mine', change_receiver: 'u1change', threshold: 2, total: 2 }
    const v = await api.getVault()
    expect(v?.id).toBe(opened)
    expect(v?.group_pubkey).toBe(opened)
    await vi.waitFor(() => expect(storage.recordChangeReceiver).toHaveBeenCalledWith(opened, 'u1change'))
  })

  it('refuses an answer about a different vault, and records nothing from it', async () => {
    answer = { vault_id: other, address: 'u1other', change_receiver: 'u1otherchange', threshold: 2, total: 2 }
    expect(await api.getVault()).toBeNull()
    await new Promise((r) => setTimeout(r, 20)) // the record writes are fire-and-forget
    expect(storage.recordChangeReceiver).not.toHaveBeenCalled()
    expect(storage.updateVaultMeta).not.toHaveBeenCalled()
  })
})

// The address a member deposits to. Receive, the dashboard and Settings showed the address the
// coordinator answered with on every load, so a coordinator taken over after the vault was created
// could answer with its own and take every deposit made from Add funds, without a signature.
// The money gate already reads the vault's own address from this device's record (#610); the
// screens now read the same one, and say so when the coordinator answers with another.
describe('getVault gives the address this device recorded', () => {
  beforeEach(() => {
    storage.listVaults.mockClear()
    storage.updateVaultMeta.mockClear()
  })

  it('shows the recorded address, and flags a coordinator that answers with another', async () => {
    storage.listVaults.mockResolvedValue([{ id: opened, address: 'u1recorded' }])
    answer = { vault_id: opened, address: 'u1served', threshold: 2, total: 2 }
    const v = await api.getVault()
    expect(v?.orchard_address).toBe('u1recorded')
    expect(v?.served_address_differs).toBe(true)
    await new Promise((r) => setTimeout(r, 20)) // the record writes are fire-and-forget
    expect(storage.updateVaultMeta).not.toHaveBeenCalled() // the record is never replaced
  })

  it('raises nothing when the coordinator answers with the recorded address', async () => {
    storage.listVaults.mockResolvedValue([{ id: opened, address: 'u1recorded' }])
    answer = { vault_id: opened, address: ' u1recorded ', threshold: 2, total: 2 }
    const v = await api.getVault()
    expect(v?.orchard_address).toBe('u1recorded')
    expect(v?.served_address_differs).toBe(false)
  })

  it('uses the answer, and records it, only when this device has no address yet', async () => {
    // A record written before the create screen kept the address (#501): the coordinator's first
    // answer is all there is, and the backfill makes it the record from then on.
    storage.listVaults.mockResolvedValue([{ id: opened, address: '' }])
    answer = { vault_id: opened, address: 'u1served', threshold: 2, total: 2 }
    const v = await api.getVault()
    expect(v?.orchard_address).toBe('u1served')
    expect(v?.served_address_differs).toBe(false)
    await vi.waitFor(() => expect(storage.updateVaultMeta).toHaveBeenCalledWith(opened, { address: 'u1served' }))
  })

  it('keeps the recorded address when the coordinator answers with none', async () => {
    storage.listVaults.mockResolvedValue([{ id: opened, address: 'u1recorded' }])
    answer = { vault_id: opened, threshold: 2, total: 2 }
    const v = await api.getVault()
    expect(v?.orchard_address).toBe('u1recorded')
    expect(v?.served_address_differs).toBe(false)
  })

  it('reads the same address in capitals, and a padded record, as the same address', async () => {
    // An all-capitals encoding is the same address: a coordinator that sends one is not diverging.
    storage.listVaults.mockResolvedValue([{ id: opened, address: ' u1recorded ' }])
    answer = { vault_id: opened, address: 'U1RECORDED', threshold: 2, total: 2 }
    const v = await api.getVault()
    expect(v?.orchard_address).toBe('u1recorded')
    expect(v?.served_address_differs).toBe(false)
  })

  it('shows no address on a device with no record of the vault', async () => {
    // With no record there is nothing of this device's to show, and the coordinator's answer would be
    // trusted afresh on every load. The money gate refuses in the same state.
    answer = { vault_id: opened, address: 'u1served', threshold: 2, total: 2 }
    storage.listVaults.mockResolvedValue([])
    expect((await api.getVault())?.orchard_address).toBe('')
    storage.listVaults.mockRejectedValue(new Error('storage unavailable'))
    const v = await api.getVault()
    expect(v?.id).toBe(opened) // the vault still loads
    expect(v?.orchard_address).toBe('')
    expect(v?.served_address_differs).toBe(false)
  })

  it('reads a record whose address is not text as having none', async () => {
    // The same reading as the money gate and the backfill (addressText): the coordinator's first
    // answer is shown and recorded, instead of a throw or an answer trusted afresh on every load.
    storage.listVaults.mockResolvedValue([{ id: opened, address: 123 as unknown as string }])
    answer = { vault_id: opened, address: 'u1served', threshold: 2, total: 2 }
    const v = await api.getVault()
    expect(v?.orchard_address).toBe('u1served')
    expect(v?.served_address_differs).toBe(false)
  })

  it('survives an address that is not text, and records none', async () => {
    storage.listVaults.mockResolvedValue([{ id: opened, address: 'u1recorded' }])
    answer = { vault_id: opened, address: 123, threshold: 2, total: 2 }
    expect((await api.getVault())?.orchard_address).toBe('u1recorded')

    storage.listVaults.mockResolvedValue([{ id: opened, address: '' }])
    answer = { vault_id: opened, address: { not: 'an address' }, threshold: 2, total: 2 }
    const v = await api.getVault()
    expect(v?.orchard_address).toBe('')
    await new Promise((r) => setTimeout(r, 20)) // the record writes are fire-and-forget
    expect(storage.updateVaultMeta).not.toHaveBeenCalled()
  })
})
