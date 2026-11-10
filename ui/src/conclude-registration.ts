// Finishing a vault's registration with the coordinator: the one implementation.
//
// The end of a live creation (`finishVault` in NetVault) and the vault card of a vault whose
// registration did not finish (Vaults) both call `concludeRegistration`, and nothing else calls
// `registerVault`. Two paths to one rule is how this repo keeps paying twice.
//
// It reads the PERSISTED record (name, group key, quorum, roster, protocol), never the in-session
// copy: that one has no quorum on it, and without the quorum the vault's read key is not registered.
// The session copy is used for one thing, to sign this device's own registration.
import { lastReadFailure } from './read-failure'
import { getVault, helperConfigured, registerVault, setMembers, lastHelperPostFailure, type HelperVault } from './helper'
import { ownPkpDigest } from './pin-digest'
import { adoptVaultReceivers } from './vault-receivers'
import { listVaults, updateVaultMeta } from './storage'
import { getUnlockedShare, setUnlockedShare } from './session'
import { registerThisDevice } from './device-registration'
import { depositAddress } from './api'
import { addressText } from './approved-payment'
import { CREATION_PROTOCOL, FIRST_PINNING_PROTOCOL, isCurrentFlow, isUpdateRequired, protocolOfRecord } from './creation-protocol'

/** Why a registration was not finished. Every one keeps the record exactly as it was.
 *  - `old`: a record of the earlier creation flow, which this never registers (no network was used).
 *  - `locked`: this device holds no share in session (a passkey unlock opens the books only), so
 *    it cannot sign its own registration; nothing was registered at all.
 *  - `update`: the coordinator asks for a newer creation; `older` when this record was made by an
 *    older creation than this app speaks, so a newer app would not help and a new vault is needed.
 *  - `mismatch`: the coordinator holds the vault with another quorum than the members confirmed.
 *  - `unreachable`: the network failed. Only that.
 *  - `rejected`: the coordinator answered and said no (`status` tells a 429 apart: try again shortly). */
export type Concluded =
  | { address: string }
  | { refused: 'old' }
  | { refused: 'locked' }
  | { refused: 'update'; older: boolean }
  | { refused: 'mismatch' }
  | { refused: 'unreachable' }
  /** The coordinator stayed busy through the retries: try again, never "unreachable". */
  | { refused: 'busy' }
  | { refused: 'rejected'; status: number }
  /** The coordinator named why. */
  | { refused: 'coded'; code: CoordinatorCode }
  /** This device did not keep what a new vault's registration needs. */
  | { refused: 'nobundle' }
  /** This creation was stopped on this device. Nothing finishes it. */
  | { refused: 'abandoned' }

/** What the coordinator refuses with, and the one sentence for each. */
export const COORDINATOR_CODE_KEYS = {
  pin_needs_t_proofs: 'registration.needsProofs',
  bundle_invalid: 'registration.bundleInvalid',
  pin_read_key_split: 'registration.secretSplit',
  pin_package_differs: 'registration.packageDiffers',
  vault_closed: 'registration.vaultClosed',
  vault_unreadable: 'registration.vaultUnreadable',
  seat_needs_proof: 'registration.seatNeedsProof',
  seat_bound: 'registration.seatBound',
  read_key_needs_proof: 'registration.readKeyNeedsProof',
  read_key_pinned: 'registration.readKeyPinned',
  roster_invalid: 'registration.rosterInvalid',
  address_mismatch: 'registration.addressMismatch',
} as const

export type CoordinatorCode = keyof typeof COORDINATOR_CODE_KEYS

export function coordinatorCode(code: string | undefined): CoordinatorCode | null {
  return code !== undefined && Object.hasOwn(COORDINATOR_CODE_KEYS, code) ? (code as CoordinatorCode) : null
}

/** The dictionary key that says a refusal to the member: one wording per cause, for every screen. */
export function refusalKey(r: Exclude<Concluded, { address: string }>): string {
  switch (r.refused) {
    case 'old': return 'registration.old'
    case 'locked': return 'registration.locked'
    case 'update': return r.older ? 'registration.updateOlder' : 'net.err.updateRequired'
    case 'mismatch': return 'net.err.registrationMismatch'
    case 'unreachable': return 'registration.unreachable'
    case 'busy': return 'registration.tryAgain'
    case 'coded': return COORDINATOR_CODE_KEYS[r.code]
    case 'nobundle': return 'registration.noBundle'
    case 'abandoned': return 'registration.doNotUse'
    case 'rejected': return r.status === 429 ? 'registration.tryAgain' : 'registration.rejected'
  }
}

export async function concludeRegistration(vaultId: string): Promise<Concluded> {
  const rec = (await listVaults()).find((v) => v.id === vaultId)
  // The earlier flow kept no quorum and no protocol: never registered here, and no network is used.
  // The definition of "current flow" is the one `resumable` and the card read.
  if (!rec || !isCurrentFlow(rec)) return { refused: 'old' }
  if (rec.abandoned) return { refused: 'abandoned' }
  // A record whose id is not its group key (hand-edited) is not one this registers: said before the
  // network, instead of as a quorum mismatch it is not.
  if (rec.id.toLowerCase() !== rec.groupKey.toLowerCase()) return { refused: 'old' }
  const cp = protocolOfRecord(rec)!
  const { threshold, total } = rec as { threshold: number; total: number }
  // The share signs this device's own registration, so it must be in session. A passkey unlock
  // seats only the read secret: no share, so no registration at all (nothing half done).
  const session = getUnlockedShare(vaultId)
  if (!session) return { refused: 'locked' }
  if (!helperConfigured()) return { refused: 'unreachable' }

  // The vault's name as every member confirmed it; the fallback lives here, once.
  const name = rec.name || `net-${rec.groupKey.slice(0, 8)}`
  const protocol3 = cp >= FIRST_PINNING_PROTOCOL
  const digest = protocol3 ? await ownPkpDigest(session, threshold, total) : null
  const pinnedHere = (a: HelperVault | null) => !!a && a.state === 'pinned' && a.pkp_digest === digest
  // A device with no bundle never posts. It finishes only on a vault others pinned to its package, read
  // once: that answer is the vault. No answer is not "not pinned": only a 404 says the coordinator holds none.
  let v: HelperVault | null
  if (protocol3 && !rec.pinBundle) {
    const known = await getVault(rec.groupKey)
    if (!known && lastReadFailure('/api/vault')?.reason !== 'missing') return { refused: 'unreachable' }
    if (!known || !pinnedHere(known)) return { refused: 'nobundle' }
    v = known
  } else {
    v = await registerVault(rec.groupKey, name, threshold, total, cp, rec.pinBundle)
  }
  if (!v) {
    const failure = lastHelperPostFailure()
    // A pinned vault of an earlier protocol, refused because the coordinator now asks for a newer app:
    // the vault exists and is pinned to this device's package, so it finishes the way a device with no
    // bundle does, by reading it. Only a vault not pinned here is told it was made by an older app.
    // Only after this device posted (a bundle): a device with no bundle never posted, and a failure
    // left from an earlier post is not this one's.
    if (isUpdateRequired(failure) && protocol3 && rec.pinBundle && cp < CREATION_PROTOCOL) {
      const known = await getVault(rec.groupKey)
      if (known && pinnedHere(known)) v = known
      // No answer is not "no such vault": only a 404 says the coordinator holds none.
      else if (!known && lastReadFailure('/api/vault')?.reason !== 'missing') return { refused: 'unreachable' }
      else return { refused: 'update', older: true }
    }
  }
  if (!v) {
    const failure = lastHelperPostFailure()
    if (isUpdateRequired(failure)) return { refused: 'update', older: cp < CREATION_PROTOCOL }
    if (failure?.busy) return { refused: 'busy' }
    const code = coordinatorCode(failure?.code)
    if (code) return { refused: 'coded', code }
    // Only a 4xx is the coordinator saying no; a 5xx is it failing to answer, which is the network's case.
    if (failure && failure.status < 500) return { refused: 'rejected', status: failure.status }
    return { refused: 'unreachable' }
  }
  // The first registration of a group key wins on the coordinator. Whether its answer may be this
  // vault's address is the one rule every screen uses (`depositAddress`): not when it carries another
  // quorum than the members confirmed. The only address written below is the one it approves.
  // An answer about another vault is no answer for this one (as `getVault` holds it). And the
  // record is passed as it is, not as an empty one: an address already recorded wins over the
  // served one (#501/A9), and the record is never overwritten by a later answer.
  if (v.vault_id !== vaultId || v.vault_id !== rec.groupKey) return { refused: 'mismatch' }
  if (protocol3 && !pinnedHere(v)) return { refused: 'mismatch' }
  // Protocol 3 holds the answer to the members' quorum too, and takes no address from it (below).
  if (protocol3 && (v.threshold !== threshold || v.total !== total)) return { refused: 'mismatch' }
  const allowed = protocol3
    ? { address: '' }
    : depositAddress({ ...rec, pending: false }, addressText(v.address), { threshold: v.threshold, total: v.total })
  if (!protocol3 && !allowed.address) return { refused: 'mismatch' }

  // Each member's name (seat order) exactly as bound into the code; idempotent.
  if (rec.roster.length) {
    const roster = await setMembers(rec.groupKey, rec.roster).catch(() => null)
    if (protocol3 && !roster) {
      // On protocol 3 the roster decides who can vote. A list already there (409) is not a refusal:
      // the Members screen says when it differs. Anything else leaves this vault unfinished.
      const failure = lastHelperPostFailure()
      if (failure?.status !== 409) {
        const code = coordinatorCode(failure?.code)
        return code ? { refused: 'coded', code } : { refused: 'unreachable' }
      }
    }
  }
  // This device's keys, and the vault's read key from S (#388), registered the one way every unlock
  // registers them. Awaited: a backup asks for the viewing key, which needs the read key in place.
  // The share signs it, so it needs the unlocked copy; a locked device gets them at its next unlock.
  const registered = await registerThisDevice(vaultId, { ...session, threshold, total, cp })
  if (protocol3 && typeof registered === 'object' && 'refused' in registered) {
    const code = coordinatorCode(registered.refused)
    return code ? { refused: 'coded', code } : { refused: 'mismatch' }
  }

  if (protocol3) {
    const verdict = await adoptVaultReceivers(vaultId, { ...session, threshold, total, cp })
    if (verdict.state === 'refused') return { refused: 'coded', code: 'address_mismatch' }
    if (verdict.state === 'unavailable') return { refused: 'unreachable' }
    await updateVaultMeta(vaultId, { pending: false }).catch(() => {})
    setUnlockedShare(vaultId, { ...session, address: verdict.address })
    return { address: verdict.address }
  }
  await updateVaultMeta(vaultId, { pending: false, address: allowed.address }).catch(() => {})
  setUnlockedShare(vaultId, { ...session, address: allowed.address })
  return { address: allowed.address }
}
