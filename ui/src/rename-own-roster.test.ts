import { expect, it, vi } from 'vitest'

// A member's own rename is this device's own fact: its list follows, by seat and never by name.
const h = vi.hoisted(() => ({ meta: vi.fn(async () => {}), rename: vi.fn(async () => ({ members: ['Ana', 'Nova'] })) }))
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), renameMember: h.rename, helperConfigured: () => true }))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  updateVaultMeta: h.meta,
  listVaults: async () => [{ id: 'ab'.repeat(32), roster: ['Ana', 'Bia'] }],
}))
vi.mock('./session', async (orig) => ({ ...(await orig<typeof import('./session')>()), getUnlockedShare: () => ({ myName: 'Bia' }) }))
vi.mock('./signing', async (orig) => ({ ...(await orig<typeof import('./signing')>()), decodeBundle: () => ({ seat: 2, keyPackage: new Uint8Array(1) }) }))
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })
const api = await import('./api')

it('the seat that renamed takes the new name on this device\'s list', async () => {
  api.setSelectedVault('ab'.repeat(32))
  await api.renameSelf('Bia', 'Nova').catch(() => {})
  expect(h.meta).toHaveBeenCalledWith('ab'.repeat(32), { roster: ['Ana', 'Nova'] })
})
