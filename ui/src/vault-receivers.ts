// The one writer of a protocol-3 vault's address and change receiver. The viewing key comes from the
// coordinator and is trusted for nothing: the derivation is checked against this device's own package,
// and what comes out is the only thing recorded. The check proves the key fits this device's package,
// not that it is the key the members hold: a first answer is taken on trust, and the viewing code is
// how members find out they were not given the same one.
import { deviceCommsKey, devicePubHex } from './device-key'
import { getUfvk } from './helper'
import { decodeBundle } from './signing'
import { receiversFingerprint } from './format'
import { listVaults, loadVault, recordReceiversRefused, recordVerifiedReceivers, replaceRefusedReceivers, type VaultLoaded } from './storage'
import { ensureWasm } from './wasm-ready'
import { addressText } from './approved-payment'
import { uaIsExactly, vaultReceivers } from './wasm-pkg/konclave_wasm.js'

export type ReceiversVerdict =
  | { state: 'verified'; address: string }
  | { state: 'refused' }
  /** No answer from the coordinator. This device signs nothing until there is one. */
  | { state: 'unavailable' }

type Derived = { external: string; internal: string; externalUa: string; internalUa: string }

const deviceOf = (share: VaultLoaded) => {
  const bundle = decodeBundle(share)
  return { bundle, device: { key: deviceCommsKey(bundle.keyPackage), pubHex: devicePubHex(bundle.keyPackage) } }
}

export async function adoptVaultReceivers(vaultId: string, share: VaultLoaded): Promise<ReceiversVerdict> {
  await ensureWasm()
  const { bundle, device } = deviceOf(share)
  const keys = await getUfvk(vaultId, device)
  if (!keys) return { state: 'unavailable' }
  let derived: Derived
  try {
    derived = JSON.parse(vaultReceivers(keys.ufvk, bundle.pubkeys))
  } catch {
    await recordReceiversRefused(vaultId, '')
    return { state: 'refused' }
  }
  const fingerprint = await receiversFingerprint(vaultId, derived.external, derived.internal)
  const rec = (await listVaults()).find((v) => v.id === vaultId)
  const address = addressText(rec?.address)
  const change = addressText(rec?.changeReceiver)
  if ((address && !uaIsExactly(address, derived.external)) || (change && !uaIsExactly(change, derived.internal))) {
    await recordReceiversRefused(vaultId, fingerprint)
    return { state: 'refused' }
  }
  const kept = address || derived.externalUa
  const written = await recordVerifiedReceivers(vaultId, kept, change || derived.internalUa, fingerprint, { address, change }, keys.birthday)
  if (written === false) return { state: 'unavailable' }
  return { state: 'verified', address: kept }
}

export type RepairVerdict = ReceiversVerdict | { state: 'notConfirmed' } | { state: 'wrongPassphrase' } | { state: 'unreadable' }

// As the alphabet reads it: spacing, and the letters it maps onto its digits, do not change a code.
const code = (text: string) => text.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')

/**
 * A device that pinned a viewing key the vault does not answer with has no way back by itself: nothing
 * can tell which key is true, so no answer may clear it. Only its member may, after agreeing a code with
 * the others out of band: the passphrase, and that code typed. Only the key with that code is taken, and
 * nothing changes until it has passed for this device's own package.
 */
export async function repairVaultReceivers(vaultId: string, passphrase: string, typed: string): Promise<RepairVerdict> {
  const rec = (await listVaults()).find((v) => v.id === vaultId)
  if (rec?.receiversState !== 'refused') return { state: 'notConfirmed' }
  let share: VaultLoaded
  try {
    share = await loadVault(vaultId, passphrase)
  } catch {
    return { state: 'wrongPassphrase' }
  }
  await ensureWasm()
  let opened: ReturnType<typeof deviceOf>
  try {
    opened = deviceOf(share)
  } catch {
    return { state: 'unreadable' }
  }
  const { bundle, device } = opened
  const keys = await getUfvk(vaultId, device)
  if (!keys) return { state: 'unavailable' }
  let derived: Derived
  try {
    derived = JSON.parse(vaultReceivers(keys.ufvk, bundle.pubkeys))
  } catch {
    return { state: 'refused' }
  }
  const fingerprint = await receiversFingerprint(vaultId, derived.external, derived.internal)
  if (code(typed) !== code(fingerprint)) return { state: 'notConfirmed' }
  const swapped = await replaceRefusedReceivers(vaultId, derived.externalUa, derived.internalUa, fingerprint)
  return swapped ? { state: 'verified', address: derived.externalUa } : { state: 'notConfirmed' }
}

/**
 * The viewing key for a backup. A protocol-3 vault's only when it derives what the record holds, or a
 * backup reported complete would rebuild a wallet that reads nothing: the one served, else the one this
 * device sealed. The scan floor never rises above what this device recorded. Older vaults keep their rule.
 */
export async function checkedViewingKey(vaultId: string, share: VaultLoaded): Promise<Awaited<ReturnType<typeof getUfvk>>> {
  await ensureWasm()
  let opened: ReturnType<typeof deviceOf>
  try {
    opened = deviceOf(share)
  } catch {
    return null
  }
  const { bundle, device } = opened
  const keys = await getUfvk(vaultId, device)
  const rec = (await listVaults()).find((v) => v.id === vaultId)
  if ((rec?.cp ?? 0) < 3) return keys
  const address = addressText(rec?.address)
  const change = addressText(rec?.changeReceiver)
  const fits = (ufvk: string) => {
    try {
      const d: Derived = JSON.parse(vaultReceivers(ufvk, bundle.pubkeys))
      return !!address && !!change && uaIsExactly(address, d.external) && uaIsExactly(change, d.internal)
    } catch {
      return false
    }
  }
  const floor = share.birthday
  if (keys?.ufvk && fits(keys.ufvk)) {
    const birthday = floor === undefined ? keys.birthday : keys.birthday === undefined ? floor : Math.min(floor, keys.birthday)
    return { ...keys, birthday }
  }
  return share.ufvk && fits(share.ufvk) ? { ufvk: share.ufvk, birthday: floor } : null
}
