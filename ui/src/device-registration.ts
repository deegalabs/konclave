// Registering THIS device with the coordinator, and the one place it happens.
//
// Two keys travel in one call, and their consequences are not the same - which is the whole reason
// this file exists:
//
//   COMMS (#63)  lets the coordinator seal a SignRequest to this device. Best-effort is CORRECT
//                here: a device that did not register still signs, because an unsealed request is
//                the compat fallback until every device has registered.
//
//   WRITE (#288) is what lets this member VOTE. The gate is per VAULT and the keys are per SEAT, so
//                the moment ANY member registers, every governance write on that vault must be
//                signed - including from a seat that never registered and therefore cannot produce
//                a signature anyone can verify. For this key, "did not land" does not mean degraded,
//                it means LOCKED OUT.
//
// The best-effort reasoning was written for the comms key and was true. #288 hung the write key on
// the same call and inherited it without re-examining what it now meant. A real 2-of-3 vault then
// spent a fortnight with one member unable to approve anything: his seat had no registered key, the
// registration never fired, and nothing anywhere said so.
//
// IT ALSO USED TO LIVE INSIDE THE BACKGROUND SIGNER, which only runs when a proposal is OPEN. That
// is a deadlock rather than a delay: you need an open proposal to register, and a registered key to
// act on a proposal. Registering belongs to unlocking - the moment this device provably holds its
// share - and to nothing else.
import { ensureWasm } from './wasm-ready'
import { decodeBundle } from './signing'
import { registerDeviceKey, registerReadKey } from './helper'
import { deriveReadKey } from './vault-secret'
import { devicePubHex, deviceWriteKeyHex } from './device-key'
import type { VaultLoaded } from './storage'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/**
 * Register this device's comms and write keys for `vaultId`.
 *
 * Idempotent - the keys are derived from the share, so the same device always sends the same pair
 * and re-registering is a no-op the coordinator reports as `added: false`.
 *
 * Never throws: unlocking must not fail because the coordinator is unreachable. But a failure is
 * LOUD, because the write half decides whether this member can vote at all.
 */
export async function registerThisDevice(vaultId: string, share: VaultLoaded): Promise<boolean> {
  try {
    await ensureWasm()
    const b = decodeBundle(share)
    // READ (#388): any member that holds the vault's secret S registers its read key, the same for
    // every member. Idempotent on the coordinator, so this heals a vault whose creation ended before
    // anyone registered it: the first unlock of any member turns its read gate on. Only for vaults
    // made by the current creation (they record their quorum): an older vault's gate stays as it was,
    // so a member of it who never received S is not locked out of its reads by someone else's unlock.
    // Waited for, never thrown: the coordinator refuses the viewing key to a vault with no read key,
    // and a caller (the creation's backup) asks for it right after this resolves.
    if (share.accessSecret && share.threshold !== undefined) {
      await deriveReadKey(share.accessSecret)
        .then((rk) => registerReadKey(hex(share.groupKey), hex(rk)))
        .then((ok) => { if (!ok) console.error('[konclave] the coordinator did not take this vault\'s read key', { vault: vaultId.slice(0, 8) }) })
        .catch((error) => console.error('[konclave] could not register this vault\'s read key', { vault: vaultId.slice(0, 8), error }))
    }
    const ok = await registerDeviceKey(hex(share.groupKey), devicePubHex(b.keyPackage), {
      seat: b.seat,
      pub: deviceWriteKeyHex(b.keyPackage),
    })
    if (ok === null) {
      console.error('[konclave] this device could not register its seat with the coordinator', {
        vault: vaultId.slice(0, 8), seat: b.seat,
      })
      return false
    }
    return true
  } catch (e) {
    // Same reasoning as the branch above, for the half that fails before the request is made -
    // a WASM module that never loaded looks exactly like a coordinator that never answered.
    console.error('[konclave] this device could not register its seat with the coordinator', {
      vault: vaultId.slice(0, 8), error: e,
    })
    return false
  }
}
