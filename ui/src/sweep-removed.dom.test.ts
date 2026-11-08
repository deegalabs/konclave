// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'

// #813 cleared a vault's traces when it is removed. A vault removed before that left them in the
// browser for good. The sweep clears them when the app opens, through the same function a removal
// uses, and clears NOTHING when it cannot tell which vaults the device holds.
vi.setConfig({ testTimeout: 30_000 })

import { saveVault, type VaultData } from './storage'
import { defaultSources, sweepRemovedVaults, tracedVaultIds, type HeldSources } from './sweep-removed'
import { setSelectedVault, getSelectedVault } from './api'
import { savePrfWrap } from './prf-store'
import { writeSeen } from './seen-store'

const HELD = 'aa'.repeat(32)
const GONE = 'bb'.repeat(32)
const data = (name: string, gk: number): VaultData => ({
  name, governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey: new Uint8Array(32).fill(gk), address: `u1${name}`, roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1),
})
function seed(id: string) {
  localStorage.setItem(`konclave.benef.${id}`, '[]')
  savePrfWrap(id, { credentialId: 'cred', salt: 'salt', iv: 'iv', ct: 'ct' } as never)
  localStorage.setItem(`konclave.folha.rascunho.${id}`, '{"lines":[]}')
  localStorage.setItem(`konclave.recentPayees.${id}`, '["u1x"]')
  localStorage.setItem(`konclave.status.${id}`, '{}')
  writeSeen(id, { at: 1, states: {} })
  localStorage.setItem(`konclave.signed.${id}`, '[]')
}
// A source that holds `ids` in its records, on the web (no bridge asked) unless said otherwise.
const web = (ids: string[] = [], over: Partial<HeldSources> = {}): HeldSources => ({
  records: async () => ids.map((id) => ({ id })), net: true, bridge: async () => null, ...over,
})
const keysWith = (id: string) => Object.keys(localStorage).filter((k) => k.includes(id)).sort()
const ALL = (id: string) => [
  `konclave.benef.${id}`, `konclave.folha.rascunho.${id}`, `konclave.prf.${id}`, `konclave.recentPayees.${id}`,
  `konclave.seen.${id}`, `konclave.signed.${id}`, `konclave.status.${id}`,
].sort()

describe('the sweep of vaults this device no longer holds', () => {
  beforeEach(() => localStorage.clear())

  it('clears every trace of a vault with no record, keeps its signed record, and leaves a held vault whole', async () => {
    await saveVault(HELD, data('held', 0xaa), 'passphrase one two')
    seed(HELD)
    seed(GONE)
    setSelectedVault(GONE)
    expect(await sweepRemovedVaults(web([HELD]))).toEqual([GONE])
    expect(keysWith(GONE)).toEqual([`konclave.signed.${GONE}`])
    expect(keysWith(HELD)).toEqual(ALL(HELD))
    expect(getSelectedVault()).toBeNull()
  })

  it('on the web, a vault saved on this device is held', async () => {
    await saveVault(HELD, data('held', 0xaa), 'passphrase one two')
    seed(HELD)
    seed(GONE)
    expect(await sweepRemovedVaults({ ...defaultSources, net: true })).toEqual([GONE])
    expect(keysWith(HELD)).toEqual(ALL(HELD))
  })

  it('on the local bridge, a vault the bridge lists is held too', async () => {
    seed(HELD)
    seed(GONE)
    expect(await sweepRemovedVaults(web([], { net: false, bridge: async () => [{ id: HELD }] }))).toEqual([GONE])
    expect(keysWith(HELD)).toEqual(ALL(HELD))
  })

  it('on the local bridge, a bridge that does not answer clears nothing', async () => {
    seed(GONE)
    expect(await sweepRemovedVaults(web([], { net: false, bridge: async () => null }))).toEqual([])
    expect(keysWith(GONE)).toEqual(ALL(GONE))
    // and the default, in this test setup (the bridge, with nothing listening), is the same refusal
    expect(await sweepRemovedVaults()).toEqual([])
    expect(keysWith(GONE)).toEqual(ALL(GONE))
  })

  it('when the bridge was not asked, leaves every id that is not shaped like a browser record', async () => {
    // A hosted coordinator picked on the bridge's own origin: the bridge's vaults are not in the list,
    // and their ids are not group keys, so nothing tells the sweep they are gone.
    const BRIDGE = 'vault-dkg-1'
    seed(BRIDGE)
    seed(GONE)
    expect(await sweepRemovedVaults(web([]))).toEqual([GONE])
    expect(keysWith(BRIDGE)).toEqual(ALL(BRIDGE))
    // and on the bridge, where its list was read, the same id is a candidate like any other
    expect(await sweepRemovedVaults(web([], { net: false, bridge: async () => [] }))).toEqual([BRIDGE])
  })

  it('clears nothing when the vaults cannot be read: a failed read is not "no vaults"', async () => {
    seed(HELD)
    seed(GONE)
    expect(await sweepRemovedVaults(web([], { records: async () => { throw new Error('storage will not open') } }))).toEqual([])
    expect(keysWith(HELD)).toEqual(ALL(HELD))
    expect(keysWith(GONE)).toEqual(ALL(GONE))
  })

  it('reads the records with the reader that refuses: storage that will not open clears nothing', async () => {
    seed(GONE)
    const idb = globalThis.indexedDB
    // @ts-expect-error: this browser has no IndexedDB for the length of the test
    delete globalThis.indexedDB
    try {
      expect(await sweepRemovedVaults({ ...defaultSources, net: true })).toEqual([])
    } finally {
      globalThis.indexedDB = idb
    }
    expect(keysWith(GONE)).toEqual(ALL(GONE))
  })

  it('never touches a vault whose traces appear while the records are being read', async () => {
    seed(GONE)
    const NEW = 'cc'.repeat(32)
    const cleared = await sweepRemovedVaults(web([], { records: async () => { seed(NEW); return [] } }))
    expect(cleared).toEqual([GONE])
    expect(keysWith(NEW)).toEqual(ALL(NEW))
  })

  it('reads the bridge first and the records last, and the records again just before clearing', async () => {
    seed(GONE)
    const order: string[] = []
    let reads = 0
    const cleared = await sweepRemovedVaults({
      net: false,
      bridge: async () => { order.push('bridge'); return [] },
      // another tab imports GONE again between the first read and the clearing
      records: async () => { order.push('records'); return ++reads === 1 ? [] : [{ id: GONE }] },
    })
    expect(order).toEqual(['bridge', 'records', 'records'])
    expect(cleared).toEqual([])
    expect(keysWith(GONE)).toEqual(ALL(GONE))
  })

  it('does nothing, and reads nothing, when no per-vault key is left over', async () => {
    localStorage.setItem(`konclave.signed.${GONE}`, '[]')
    localStorage.setItem('konclave.theme', 'dark')
    const records = vi.fn(async () => [])
    expect(await sweepRemovedVaults(web([], { records }))).toEqual([])
    expect(records).not.toHaveBeenCalled()
    expect(localStorage.getItem(`konclave.signed.${GONE}`)).toBe('[]')
  })
})

describe('which keys belong to a vault', () => {
  it('reads the id after each per-vault prefix and nothing else', () => {
    expect([...tracedVaultIds([
      'konclave.benef.v1', 'konclave.folha.rascunho.v2', 'konclave.recentPayees.v3', 'konclave.seen.v4',
      'konclave.status.v5', 'konclave.prf.v6',
      'konclave.signed.v7', 'konclave.recentPayees', 'konclave.folha.rascunho', 'konclave.theme', 'konclave.benef.',
      // a key shaped like a later version of one of these is not a vault id, so the sweep never clears it
      'konclave.status.v2.abc',
    ])].sort()).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6'])
  })
})

describe('one rule for what a vault leaves behind', () => {
  it('clears through the removal function and spells no key of its own', () => {
    const src = codeOf('sweep-removed.ts')
    expect(src).toContain('clearVaultTraces(id)')
    expect(src).not.toMatch(/removeItem|'konclave\./)
  })
  it('reads the records with readVaults, never with listVaults (which answers [] when storage fails)', () => {
    const src = codeOf('sweep-removed.ts')
    expect(src).toMatch(/records: readVaults/)
    expect(src).not.toContain('listVaults')
  })
  it('runs once at startup', () => {
    expect(codeOf('main.tsx')).toMatch(/^void sweepRemovedVaults\(\)$/m)
  })
})
