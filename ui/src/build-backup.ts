// The portable backup of a vault: the one builder.
//
// The end of a creation, Settings' export and the vault card that finishes a registration all build
// the same thing (the encrypted export, carrying the viewing key and the scan floor), and each used
// to write it out. One function, so a field added to the backup reaches all three.
import { ensureWasm } from './wasm-ready'
import { checkedViewingKey } from './vault-receivers'
import { backupFileName, exportVault, listVaults, loadVault } from './storage'

export type VaultBackup = { json: string; name: string; complete: boolean }

/**
 * Build the backup of `vaultId` under `passphrase`, which also opens the record it is checked against. Throws when the export cannot be built: each
 * caller decides what that means for its screen.
 */
export async function buildVaultBackup(
  vaultId: string,
  passphrase: string,
  // Kept so the callers do not change; the name no longer carries it (#587).
  _vaultName: string | undefined,
): Promise<VaultBackup> {
  // The WASM has to be up before the device key is derived or the envelope opened (#483).
  await ensureWasm()
  // The viewing key AND the scan floor, from one gated call (#480). Best-effort by design: a vault
  // with no read key, or a locked device, gets null and an incomplete export beats none.
  // The record under the passphrase, on every path: a session copy may not hold the scan floor.
  const keys = await checkedViewingKey(vaultId, await loadVault(vaultId, passphrase))
  // Protocol 3: what was checked is all that goes, or the record's own key would slip past the check.
  const checkedOnly = ((await listVaults()).find((v) => v.id === vaultId)?.cp ?? 0) >= 3
  const exp = checkedOnly
    ? await exportVault(vaultId, passphrase, keys?.ufvk, keys?.birthday, { storedKey: false })
    : await exportVault(vaultId, passphrase, keys?.ufvk, keys?.birthday)
  return {
    json: JSON.stringify(exp, null, 2),
    name: backupFileName(new Date()), // neutral: the name says nothing about the vault (#587)
    complete: Boolean(keys?.ufvk && keys?.birthday !== undefined),
  }
}
