// A creation that stopped: the share leaves the session first, and the record says so after.
import { clearUnlockedShare } from './session'
import { updateVaultMeta } from './storage'

export async function stopCreation(vaultId: string, why: string): Promise<void> {
  clearUnlockedShare(vaultId)
  await updateVaultMeta(vaultId, { abandoned: why }).catch(() => {})
}
