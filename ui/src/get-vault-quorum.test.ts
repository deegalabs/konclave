// The quorum a vault shows, through the real getVault: this device's own record first (the count its
// members confirmed at creation), the coordinator's answer only where the record has none. Settings
// and every other screen read the quorum from getVault alone, so this is the one place it is decided.
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })

const ID = 'cd'.repeat(32)
const h = vi.hoisted(() => ({ records: [] as object[], served: { threshold: 3, total: 5 } as { threshold?: number; total?: number }, listThrows: false }))
vi.mock('./helper', async (orig) => ({
  ...(await orig<typeof import('./helper')>()),
  helperConfigured: () => true,
  getVault: async () => ({ vault_id: ID, address: '', state: 'pinned', name: 'x', ...h.served }),
  listMembers: async () => null,
}))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => { if (h.listThrows) throw new Error('no store'); return h.records },
}))
const api = await import('./api')

beforeEach(() => {
  api.setSelectedVault(ID)
  h.records = []
  h.served = { threshold: 3, total: 5 }
  h.listThrows = false
})

describe('the quorum getVault answers', () => {
  it('the record’s threshold and member count win over the coordinator’s', async () => {
    h.records = [{ id: ID, name: 'Treasury', roster: ['Ana', 'Bia'], threshold: 2, total: 2 }]
    const v = await api.getVault()
    expect(v?.threshold).toBe(2)
    expect(v?.total).toBe(2)
    expect(v?.member_list).toHaveLength(2)
  })
  it('a record without them leaves the coordinator’s answer', async () => {
    h.records = [{ id: ID, name: 'Treasury', roster: [] }]
    const v = await api.getVault()
    expect(v?.threshold).toBe(3)
    expect(v?.total).toBe(5)
  })
  it('no record on this device, or a store that cannot be read: the coordinator’s answer', async () => {
    let v = await api.getVault()
    expect([v?.threshold, v?.total]).toEqual([3, 5])
    h.listThrows = true
    v = await api.getVault()
    expect([v?.threshold, v?.total]).toEqual([3, 5])
  })
  it('a record of another vault is not this vault’s', async () => {
    h.records = [{ id: 'ef'.repeat(32), name: 'Other', roster: [], threshold: 1, total: 1 }]
    const v = await api.getVault()
    expect([v?.threshold, v?.total]).toEqual([3, 5])
  })
  it('neither says: zero, never a guess', async () => {
    h.served = {}
    const v = await api.getVault()
    expect([v?.threshold, v?.total]).toEqual([0, 0])
  })
})
