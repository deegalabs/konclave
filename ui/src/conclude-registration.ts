// Finishing a vault's registration with the coordinator: the one implementation.
//
// The end of a live creation (`finishVault` in NetVault) and the vault card of a vault whose
// registration did not finish (Vaults) both call `concludeRegistration`, and nothing else calls
// `registerVault`. Two paths to one rule is how this repo keeps paying twice.
//
// It reads the PERSISTED record (name, group key, quorum, roster, protocol), never the in-session
// copy: that one has no quorum on it, and without the quorum the vault's read key is not registered.
// The session copy is used for one thing, to sign this device's own registration.
import { helperConfigured, registerVault, setMembers, lastHelperPostFailure } from './helper'
import { listVaults, updateVaultMeta } from './storage'
import { getUnlockedShare, setUnlockedShare } from './session'
import { registerThisDevice } from './device-registration'
import { depositAddress } from './api'
import { addressText } from './approved-payment'
import { CREATION_PROTOCOL, isUpdateRequired, protocolOfRecord } from './creation-protocol'

/** Why a registration was not finished. Every one keeps the record exactly as it was.
 *  - `old`: a record of the earlier creation flow, which this never registers (no network was used).
 *  - `update`: the coordinator asks for a newer creation; `older` when this record was made by an
 *    older creation than this app speaks, so a newer app would not help and a new vault is needed.
 *  - `mismatch`: the coordinator holds the vault with another quorum than the members confirmed.
 *  - `unreachable`: the network failed. Only that.
 *  - `rejected`: the coordinator answered and said no (`status` tells a 429 apart: try again shortly). */
export type Concluded =
  | { address: string }
  | { refused: 'old' }
  | { refused: 'update'; older: boolean }
  | { refused: 'mismatch' }
  | { refused: 'unreachable' }
  | { refused: 'rejected'; status: number }

/** The dictionary key that says a refusal to the member: one wording per cause, for every screen. */
export function refusalKey(r: Exclude<Concluded, { address: string }>): string {
  switch (r.refused) {
    case 'old': return 'registration.old'
    case 'update': return r.older ? 'registration.updateOlder' : 'net.err.updateRequired'
    case 'mismatch': return 'net.err.registrationMismatch'
    case 'unreachable': return 'registration.unreachable'
    case 'rejected': return r.status === 429 ? 'registration.tryAgain' : 'registration.rejected'
  }
}

export async function concludeRegistration(vaultId: string): Promise<Concluded> {
  const rec = (await listVaults()).find((v) => v.id === vaultId)
  const cp = rec ? protocolOfRecord(rec) : undefined
  // The earlier flow kept no quorum and no protocol: never registered here, and no network is used.
  if (!rec || cp === undefined || rec.threshold === undefined || rec.total === undefined) return { refused: 'old' }
  if (!helperConfigured()) return { refused: 'unreachable' }
  const { threshold, total } = rec

  // The vault's name as every member confirmed it; the fallback lives here, once.
  const name = rec.name || `net-${rec.groupKey.slice(0, 8)}`
  const v = await registerVault(rec.groupKey, name, threshold, total, cp)
  if (!v) {
    const failure = lastHelperPostFailure()
    if (isUpdateRequired(failure)) return { refused: 'update', older: cp < CREATION_PROTOCOL }
    if (failure) return { refused: 'rejected', status: failure.status }
    return { refused: 'unreachable' }
  }
  // The first registration of a group key wins on the coordinator. Whether its answer may be this
  // vault's address is the one rule every screen uses (`depositAddress`): not when it carries another
  // quorum than the members confirmed. The only address written below is the one it approves.
  const allowed = depositAddress({ address: '', threshold, total }, addressText(v.address), { threshold: v.threshold, total: v.total })
  if (!allowed.address) return { refused: 'mismatch' }

  // Each member's name (seat order) exactly as bound into the code; idempotent.
  if (rec.roster.length) await setMembers(rec.groupKey, rec.roster).catch(() => null)
  // This device's keys, and the vault's read key from S (#388), registered the one way every unlock
  // registers them. Awaited: a backup asks for the viewing key, which needs the read key in place.
  // The share signs it, so it needs the unlocked copy; a locked device gets them at its next unlock.
  const session = getUnlockedShare(vaultId)
  if (session) await registerThisDevice(vaultId, { ...session, threshold, total })

  await updateVaultMeta(vaultId, { pending: false, address: allowed.address }).catch(() => {})
  if (session) setUnlockedShare(vaultId, { ...session, address: allowed.address })
  return { address: allowed.address }
}
