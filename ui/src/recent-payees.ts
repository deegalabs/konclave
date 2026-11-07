// The last few addresses this device paid, offered first in the recipient field. Per vault (#813):
// they sat under one key for every vault, so one vault offered another vault's payees, and removing
// a vault could not take them with it.
import { getSelectedVault } from './api'

/** The unkeyed list of earlier versions. Whose vault it belongs to cannot be known, so it is never
 *  read again, only dropped (as the payroll draft's was). */
export const LEGACY_RECENTS_KEY = 'konclave.recentPayees'
export const recentPayeesKey = (vaultId: string) => `${LEGACY_RECENTS_KEY}.${vaultId}`
const MAX = 4

function dropLegacy(): void {
  try { localStorage.removeItem(LEGACY_RECENTS_KEY) } catch { /* storage unavailable */ }
}

/** The selected vault's recent addresses, newest first; none when no vault is selected. */
export function recentPayees(): string[] {
  dropLegacy()
  const id = getSelectedVault()
  if (!id) return []
  try { return JSON.parse(localStorage.getItem(recentPayeesKey(id)) ?? '[]') as string[] } catch { return [] }
}

export function pushRecentPayee(addr: string): void {
  const id = getSelectedVault()
  if (!id) return
  try {
    const next = [addr, ...recentPayees().filter((a) => a !== addr)].slice(0, MAX)
    localStorage.setItem(recentPayeesKey(id), JSON.stringify(next))
  } catch { /* storage blocked */ }
}

export function clearRecentPayees(vaultId: string): void {
  dropLegacy()
  try { localStorage.removeItem(recentPayeesKey(vaultId)) } catch { /* storage unavailable */ }
}
