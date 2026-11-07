// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'

// #813 cleared a vault's traces when it is removed. A vault removed before that left them in the
// browser for good. The sweep clears them when the app opens, through the same function a removal
// uses, and clears NOTHING when it cannot tell which vaults the device holds.
vi.setConfig({ testTimeout: 30_000 })

import { readVaults, saveVault, type VaultData } from './storage'
import { heldVaultIds, sweepRemovedVaults, tracedVaultIds } from './sweep-removed'
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
    const held = new Set([HELD])
    expect(await sweepRemovedVaults(async () => held)).toEqual([GONE])
    expect(keysWith(GONE)).toEqual([`konclave.signed.${GONE}`])
    expect(keysWith(HELD)).toEqual(ALL(HELD))
    expect(getSelectedVault()).toBeNull()
  })

  it('on the web, a vault saved on this device is held', async () => {
    await saveVault(HELD, data('held', 0xaa), 'passphrase one two')
    seed(HELD)
    seed(GONE)
    const held = () => heldVaultIds({ records: readVaults, net: true, bridge: async () => null })
    expect(await sweepRemovedVaults(held)).toEqual([GONE])
    expect(keysWith(HELD)).toEqual(ALL(HELD))
  })

  it('on the local bridge, a vault the bridge lists is held too', async () => {
    seed(HELD)
    seed(GONE)
    const held = () => heldVaultIds({ records: readVaults, net: false, bridge: async () => [{ id: HELD }] })
    expect(await sweepRemovedVaults(held)).toEqual([GONE])
    expect(keysWith(HELD)).toEqual(ALL(HELD))
  })

  it('on the local bridge, a bridge that does not answer clears nothing', async () => {
    seed(GONE)
    const held = () => heldVaultIds({ records: readVaults, net: false, bridge: async () => null })
    expect(await sweepRemovedVaults(held)).toEqual([])
    expect(keysWith(GONE)).toEqual(ALL(GONE))
    // and the default, in this test setup (the bridge, with nothing listening), is the same refusal
    expect(await sweepRemovedVaults()).toEqual([])
    expect(keysWith(GONE)).toEqual(ALL(GONE))
  })

  it('clears nothing when the vaults cannot be read: a failed read is not "no vaults"', async () => {
    seed(HELD)
    seed(GONE)
    expect(await sweepRemovedVaults(async () => { throw new Error('storage will not open') })).toEqual([])
    expect(keysWith(HELD)).toEqual(ALL(HELD))
    expect(keysWith(GONE)).toEqual(ALL(GONE))
  })

  it('never touches a vault whose traces appear while the records are being read', async () => {
    seed(GONE)
    const NEW = 'cc'.repeat(32)
    const cleared = await sweepRemovedVaults(async () => { seed(NEW); return new Set() })
    expect(cleared).toEqual([GONE])
    expect(keysWith(NEW)).toEqual(ALL(NEW))
  })

  it('does nothing, and reads nothing, when no per-vault key is left over', async () => {
    localStorage.setItem(`konclave.signed.${GONE}`, '[]')
    localStorage.setItem('konclave.theme', 'dark')
    const held = vi.fn(async () => new Set<string>())
    expect(await sweepRemovedVaults(held)).toEqual([])
    expect(held).not.toHaveBeenCalled()
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
  it('runs once at startup', () => {
    expect(codeOf('main.tsx')).toMatch(/^void sweepRemovedVaults\(\)$/m)
  })
})
