// The payroll draft: addresses, amounts and memos typed on this device, kept so a reload does not
// lose them. It sat under ONE key for every vault, so a draft typed in one vault opened in another,
// and it outlived the lock and the vault's removal. Keyed by vault id now, and cleared on both.

/** The unkeyed draft of earlier versions. Whose vault it belongs to cannot be known, so it is
 *  never read again, only dropped. */
export const LEGACY_DRAFT_KEY = 'konclave.folha.rascunho'

export const draftKey = (vaultId: string) => `${LEGACY_DRAFT_KEY}.${vaultId}`

/** Drop a vault's draft (and the legacy one). Storage being unavailable is not an error here. */
export function clearPayrollDraft(vaultId: string): void {
  try {
    localStorage.removeItem(draftKey(vaultId))
    localStorage.removeItem(LEGACY_DRAFT_KEY)
  } catch { /* storage unavailable */ }
}
