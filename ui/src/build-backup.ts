// The portable backup of a vault: the one builder.
//
// The end of a creation, Settings' export and the vault card that finishes a registration all build
// the same thing (the encrypted export, carrying the viewing key and the scan floor), and each used
// to write it out. One function, so a field added to the backup reaches all three.
import { ensureWasm } from './wasm-ready'
import { checkedViewingKey } from './vault-receivers'
import { backupFileName, exportVault, listVaults, loadVault } from './storage'

/** `peopleLeftOut`: the saved people could not be opened on this device, so the backup was made without them. */
export type VaultBackup = { json: string; name: string; complete: boolean; peopleLeftOut?: boolean; keyMissing?: boolean }

/** The notices an incomplete backup owes the member, as i18n keys: ONE reader for every screen. Each
 *  named cause gets its own; a backup that is incomplete for a cause nobody named still gets the
 *  generic one, so an incomplete file never goes without a warning. */
export function incompleteNotices(b: Pick<VaultBackup, 'complete' | 'peopleLeftOut' | 'keyMissing'>): string[] {
  const out: string[] = []
  if (b.peopleLeftOut) out.push('export.peopleLeftOut')
  if (b.keyMissing || (!b.complete && !b.peopleLeftOut)) out.push('vaults.resumeBackupIncomplete')
  return out
}

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
  const report: { peopleLeftOut?: boolean } = {}
  const exp = checkedOnly
    ? await exportVault(vaultId, passphrase, keys?.ufvk, keys?.birthday, { storedKey: false, report })
    : await exportVault(vaultId, passphrase, keys?.ufvk, keys?.birthday, { report })
  return {
    json: JSON.stringify(exp, null, 2),
    name: backupFileName(new Date()), // neutral: the name says nothing about the vault (#587)
    complete: Boolean(keys?.ufvk && keys?.birthday !== undefined) && !report.peopleLeftOut,
    // The two causes apart, so a screen can say each: `complete` is false for either.
    ...(keys?.ufvk && keys?.birthday !== undefined ? {} : { keyMissing: true }),
    ...(report.peopleLeftOut ? { peopleLeftOut: true } : {}),
  }
}
