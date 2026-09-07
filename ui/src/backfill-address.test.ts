import { beforeEach, describe, expect, it, vi } from 'vitest'

// #501's other half, and the shape of the miss.
//
// #501 made the create screen record the vault's address. It did nothing for the vaults that already
// existed, because `saveVault` runs ONLY at creation - it has exactly one caller - so nothing ever
// revisits a record. Every vault made before that fix holds `address: ''` permanently, and its
// backups keep reporting the address missing however many times the member re-exports.
//
// That is the same shape as the defect it was fixing: repair the new path, leave the population. So
// the address is backfilled from the helper, which is the only other place it exists - the device
// cannot re-derive one, since `zcash-sign` mints it from a random `sk` it discards.
//
// The condition is tested here rather than inside `getVault` so it can be exercised without a
// network, and so the repair does not become what it repairs: a branch nobody can run.

const listVaults = vi.hoisted(() => vi.fn())
const updateVaultMeta = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./storage', () => ({ listVaults, updateVaultMeta }))

const { backfillAddress } = await import('./api')

const ADDR = 'u1qz8vt5m3gk9wr7hxne2d0lfp4yjaus6cvbq0t9mr2xk7dwh5nz3ge8pvc4ys6ta'
const rec = (address: string) => ({ id: 'v1', groupKey: 'ab', address, roster: [], createdAt: 0 })

describe('backfilling a vault address that was never recorded', () => {
  beforeEach(() => {
    listVaults.mockReset()
    updateVaultMeta.mockReset()
    updateVaultMeta.mockResolvedValue(undefined)
  })

  it('writes the address into a record that has none', async () => {
    listVaults.mockResolvedValue([rec('')])
    expect(await backfillAddress('v1', ADDR)).toBe(true)
    expect(updateVaultMeta).toHaveBeenCalledWith('v1', { address: ADDR })
  })

  it('leaves a record that already has one alone', async () => {
    // Idempotence is the whole reason this can run on every screen load without being a cost, and
    // it must never overwrite: the record's address is what the member's own backup carries.
    listVaults.mockResolvedValue([rec(ADDR)])
    expect(await backfillAddress('v1', 'u1somethingelse')).toBe(false)
    expect(updateVaultMeta).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only address as absent', async () => {
    listVaults.mockResolvedValue([rec('   ')])
    expect(await backfillAddress('v1', ADDR)).toBe(true)
  })

  it('does nothing for a vault this device does not hold', async () => {
    listVaults.mockResolvedValue([rec('')])
    expect(await backfillAddress('someone-elses-vault', ADDR)).toBe(false)
    expect(updateVaultMeta).not.toHaveBeenCalled()
  })

  it('stays silent when storage is unavailable', async () => {
    // A private window, blocked site data, a quota error. This runs on screens that must render
    // regardless; a repair that can break a page is worse than the gap it closes.
    listVaults.mockRejectedValue(new Error('no IndexedDB'))
    expect(await backfillAddress('v1', ADDR)).toBe(false)
  })
})
