// Removing a vault from this device (#813): one function, called by every screen that offers it, so
// what is removed cannot differ by screen. It did: Vaults cleared the read secret and the passkey
// wrap, Settings did not, and neither cleared the payee book or the recent addresses.
//
// Removed: the record (sealed share, public metadata, `deleteVault`), the payroll draft, the share
// and the read secret held in this session, the passkey wrap, the payee book, the recent addresses,
// what "What changed" last showed, what the vault list last showed for it, and the selection when
// it points at this vault. Every place the app writes to this browser's storage is listed, with
// what happens to it here, in `remove-vault.dom.test.ts`.
// Kept on purpose: the signed record (`signed-record.ts`), the device's memory of what it already
// signed. It holds hashes and expiries only, and it is what refuses a second transaction for a
// payment this device signed, should the vault come back from a backup.
import { forgetVault, beneficiariesKey } from './storage'
import { getSelectedVault, clearSelectedVault } from './api'
import { clearUnlockedShare, clearReadSecret } from './session'
import { clearPrfWrap } from './prf-store'
import { clearRecentPayees } from './recent-payees'
import { clearPayrollDraft } from './payroll-draft'
import { forgetStatus } from './vault-status'
import { clearSeen } from './seen-store'

/** True only when the record is really gone; nothing else is cleared otherwise, so a failed removal
 *  leaves the vault whole and the screen can say so. */
export async function removeVaultFromDevice(id: string): Promise<boolean> {
  const gone = await forgetVault(id).catch(() => false)
  if (!gone) return false
  clearVaultTraces(id)
  return true
}

/** Everything this device keeps for a vault besides its record. Called on its own when the record
 *  was not this browser's to delete: on the local bridge the orchestrator deletes it, and what the
 *  browser kept for that vault goes the same way as on the web. */
export function clearVaultTraces(id: string): void {
  clearPayrollDraft(id)
  clearUnlockedShare(id)
  clearReadSecret(id)
  clearPrfWrap(id)
  try { localStorage.removeItem(beneficiariesKey(id)) } catch { /* storage unavailable */ }
  clearRecentPayees(id)
  forgetStatus(id)
  clearSeen(id)
  if (getSelectedVault() === id) clearSelectedVault()
}
