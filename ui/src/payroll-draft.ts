// The payroll draft: addresses, amounts and memos typed on this device, kept so a reload does not
// lose them. It sat under ONE key for every vault, so a draft typed in one vault opened in another,
// and it outlived the lock and the vault's removal. Keyed by vault id now, and cleared on both.
// Through vault-local.ts: for a PROTECTED vault the draft is held in memory only while it is unlocked
// and nothing is written to storage; an open vault and the local bridge keep it in storage as before.
import { LEGACY_DRAFT_KEY as LEGACY, clearLegacyKeys, clearLocal, keptIn, readLocal, updateLocal, vaultKey, type LocalWrite } from './vault-local'

/** The unkeyed draft of earlier versions. Whose vault it belongs to cannot be known, so it is
 *  never read again, only dropped. */
export const LEGACY_DRAFT_KEY = LEGACY

export const draftKey = (vaultId: string) => vaultKey('draft', vaultId)

/** The vault's draft, or null when there is none or it cannot be read (locked). */
export async function readPayrollDraft(vaultId: string): Promise<unknown | null> {
  const r = await readLocal(vaultId, 'draft')
  return r.s === 'ok' ? r.value : null
}
/** What the write did: 'written', or why not ('locked', 'failed'). */
export async function savePayrollDraft(vaultId: string, draft: unknown): Promise<LocalWrite> {
  return updateLocal(vaultId, 'draft', () => draft)
}
/** Where the draft is kept right now ('memory' for a protected vault that is unlocked). */
export const draftKeptIn = (vaultId: string) => keptIn(vaultId, 'draft')

/** Drop a vault's draft (and the legacy one). Storage being unavailable is not an error here. */
export function clearPayrollDraft(vaultId: string): void {
  clearLegacyKeys()
  clearLocal(vaultId, 'draft')
}
