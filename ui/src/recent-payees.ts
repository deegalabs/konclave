// The last few addresses this device paid, offered first in the recipient field. Per vault (#813):
// they sat under one key for every vault, so one vault offered another vault's payees, and removing
// a vault could not take them with it. Kept through vault-local.ts: sealed on a protected vault's
// device, read asynchronously, nothing offered and nothing written while it is locked.
import { shownVault } from './shown-vault'
import { LEGACY_RECENTS_KEY as LEGACY, REFUSE, clearLegacyKeys, clearLocal, readLocal, updateLocal } from './vault-local'

/** The unkeyed list of earlier versions. Whose vault it belongs to cannot be known, so it is never
 *  read again, only dropped (as the payroll draft's was). */
export const LEGACY_RECENTS_KEY = LEGACY
const MAX = 4

/** The shown vault's recent addresses, newest first; none when the screen names no vault, or when the
 *  list cannot be read (locked, unreadable). */
export async function recentPayees(shown: string | null): Promise<string[]> {
  clearLegacyKeys()
  const id = shown
  if (!id) return []
  const r = await readLocal(id, 'recent')
  return r.s === 'ok' && Array.isArray(r.value) ? (r.value as unknown[]).filter((a): a is string => typeof a === 'string') : []
}

export async function pushRecentPayee(shown: string | null, addr: string): Promise<void> {
  const sv = shownVault(shown)
  if (!sv.ok) return
  await updateLocal(sv.id, 'recent', (cur) => (cur === undefined ? [addr] : Array.isArray(cur) ? [addr, ...cur.filter((a) => a !== addr)].slice(0, MAX) : REFUSE))
}

export function clearRecentPayees(vaultId: string): void {
  clearLegacyKeys()
  clearLocal(vaultId, 'recent')
}
