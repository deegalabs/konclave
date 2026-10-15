// The portable backup of a vault: the one builder.
//
// The end of a creation, Settings' export and the vault card that finishes a registration all build
// the same thing (the encrypted export, carrying the viewing key and the scan floor), and each used
// to write it out. One function, so a field added to the backup reaches all three.
import { ensureWasm } from './wasm-ready'
import { decodeBundle } from './signing'
import { deviceCommsKey, devicePubHex } from './device-key'
import { getUfvk } from './helper'
import { exportVault, type VaultLoaded } from './storage'

export type VaultBackup = { json: string; name: string; complete: boolean }

/**
 * Build the backup of `vaultId` under `passphrase`. `share` is the unlocked copy on this device (its
 * device key opens the viewing key the coordinator seals); without it the export degrades to the
 * plaintext compat path and says it is incomplete. Throws when the export cannot be built: each
 * caller decides what that means for its screen.
 */
export async function buildVaultBackup(
  vaultId: string,
  passphrase: string,
  share: VaultLoaded | undefined,
  vaultName: string | undefined,
): Promise<VaultBackup> {
  // The WASM has to be up before the device key is derived or the envelope opened (#483).
  await ensureWasm()
  const device = share
    ? (() => {
        const kp = decodeBundle(share).keyPackage
        return { key: deviceCommsKey(kp), pubHex: devicePubHex(kp) }
      })()
    : undefined
  // The viewing key AND the scan floor, from one gated call (#480). Best-effort by design: a vault
  // with no read key, or a locked device, gets null and an incomplete export beats none.
  const keys = await getUfvk(vaultId, device)
  const exp = await exportVault(vaultId, passphrase, keys?.ufvk, keys?.birthday)
  const safe = (vaultName ?? 'konclave-vault').replace(/[^\w.-]+/g, '-').toLowerCase()
  return {
    json: JSON.stringify(exp, null, 2),
    name: `${safe}.konclave.json`,
    complete: Boolean(keys?.ufvk && keys?.birthday !== undefined),
  }
}
