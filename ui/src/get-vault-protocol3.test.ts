// The deposit address a protocol-3 vault shows, through the real getVault and the real store: only
// what this device verified, never what the coordinator serves.
import 'fake-indexeddb/auto'
import { beforeAll, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 60_000 })
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) })
const GK = 'ab'.repeat(32), SERVED = 'u1servedaddress', CHG = 'u1servedchange'
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), helperConfigured: () => true,
  getVault: async () => ({ vault_id: GK, address: SERVED, change_receiver: CHG, threshold: 2, total: 3, state: 'pinned', name: 'x' }),
  listMembers: async () => ['Ana', 'Zed', 'Caio'] }))
const { saveVault, listVaults, recordVerifiedReceivers, recordReceiversRefused, updateVaultMeta } = await import('./storage')
const api = await import('./api')
const data = (over = {}) => ({ name: 'V', governance: 'quorum', myName: 'Ana', creatorName: 'Ana', groupKey: new Uint8Array(32).fill(0xab), address: '', roster: ['Ana', 'Bia', 'Caio'], sealedShare: new Uint8Array(3), threshold: 2, total: 3, cp: 3, ...over }) as never
const rec = async () => (await listVaults()).find((v) => v.id === GK)!
const show = async (_when: string) => { const v = await api.getVault(); await new Promise((r) => setTimeout(r, 30)); const r = await rec(); return { v, r } }
beforeAll(() => { api.setSelectedVault(GK) })
it('getVault, real, cp 3', async () => {
  await saveVault(GK, data({ pending: true }), 'river stone maple lantern')
  let s = await show('pending empty'); expect(s.v?.orchard_address).toBe(''); expect(s.r.address).toBeFalsy()
  await updateVaultMeta(GK, { pending: false })
  s = await show('finished, unverified, empty'); expect(s.v?.orchard_address).toBe(''); expect(s.v?.address_gate).toBe('waiting'); expect(s.r.address).toBeFalsy(); expect(s.r.changeReceiver).toBeFalsy()
  await recordVerifiedReceivers(GK, 'u1mine', 'u1minechange', 'CODE')
  s = await show('verified, code not compared'); expect(s.v?.orchard_address).toBe(''); expect(s.v?.address_gate).toBe('compare'); expect(s.v?.viewing_code).toBe('CODE')
  await updateVaultMeta(GK, { codeCompared: true })
  s = await show('verified'); expect(s.v?.orchard_address).toBe('u1mine'); expect(s.v?.address_gate).toBeUndefined(); expect(s.r.changeReceiver).toBe('u1minechange'); expect(s.v?.roster_differs).toBe(true)
  await recordReceiversRefused(GK, 'OTHER')
  s = await show('refused'); expect(s.v?.orchard_address).toBe(''); expect(s.v?.address_gate).toBe('refused'); expect(s.r.address).toBe('u1mine')
})

it('depositAddress leaves a stopped vault with nothing to show', () => {
  expect(api.depositAddress({ address: 'a', abandoned: 'secret' }, 'served', {})).toEqual({ address: '', adopt: false })
})

