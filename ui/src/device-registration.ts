// Registering THIS device with the coordinator, and the one place it happens.
//
// Two keys travel in one call, and their consequences are not the same - which is the whole reason
// this file exists:
//
//   COMMS (#63)  lets the coordinator seal a SignRequest to this device. On an older vault a device
//                that did not register still signs, because an unsealed request is the compat
//                fallback there. Protocol 3 has no such fallback: a device the coordinator refused
//                gets no box. A refusal that carries the coordinator's code disarms the signer and
//                the shell says why; one without a code (a 400, 401, 409, 429) shows the dashboard
//                banner, and a device left armed has no box to open, so it contributes nothing.
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
import { registerDeviceKeyResult, registerReadKeyResult } from './helper'
import { noteSeatRefused, noteSeatRegistered, seatRefusalKey } from './seat-registration'
import { deriveReadKey } from './vault-secret'
import * as wasm from './wasm-pkg/konclave_wasm.js'
import { devicePubHex, deviceWriteKeyHex } from './device-key'
import type { VaultLoaded } from './storage'

/**
 * The height from which THIS build accepts the lower network fee (ZIP 2009), read from the era table
 * in the wasm - never a number typed here. Absent when the loaded wasm has no such export (an older
 * one): the field is then omitted, and the coordinator reads a registration without it as "this seat
 * reports nothing", which is the safe side.
 */
function reportedFeeFrom(): number | undefined {
  try {
    const f = (wasm as { feeFrom?: () => number | undefined }).feeFrom
    const h = typeof f === 'function' ? f() : undefined
    return Number.isSafeInteger(h) && (h as number) >= 0 ? h : undefined
  } catch {
    return undefined
  }
}

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
export async function registerThisDevice(vaultId: string, share: VaultLoaded): Promise<boolean | { refused: string }> {
  try {
    await ensureWasm()
    const b = decodeBundle(share)
    // READ (#388): any member that holds the vault's secret S registers its read key, the same for
    // every member. Idempotent on the coordinator. Since protocol 3 the coordinator takes no FIRST read
    // key without the seats' proofs, so this no longer turns the gate on for a vault of an earlier
    // creation that ended before anyone registered its key: such a vault stays as it was. Only for vaults
    // made by the current creation (they record their quorum): an older vault's gate stays as it was,
    // so a member of it who never received S is not locked out of its reads by someone else's unlock.
    // Waited for, never thrown: the coordinator refuses the viewing key to a vault with no read key,
    // and a caller (the creation's backup) asks for it right after this resolves.
    if (share.accessSecret && share.threshold !== undefined) {
      const taken = await deriveReadKey(share.accessSecret)
        .then((rk) => registerReadKeyResult(hex(share.groupKey), hex(rk)))
        .catch((error) => {
          console.error('[konclave] could not register this vault\'s read key', { vault: vaultId.slice(0, 8), error })
          return null
        })
      // The refusal is the answer of THIS call; no other post can stand in for it.
      if (taken && (('failure' in taken) || !taken.ok)) {
        console.error('[konclave] the coordinator did not take this vault\'s read key', { vault: vaultId.slice(0, 8) })
        const code = 'failure' in taken ? taken.failure?.code : undefined
        // A pinned vault's key either is this one or this device does not belong: not a thing to go on from.
        if (share.cp !== undefined && share.cp >= 3 && code) {
          noteSeatRefused(vaultId, 'registration.seatRefused', code)
          return { refused: code }
        }
      }
    }
    // Protocol 3: this seat's own certificate, which is what a pinned vault takes a seat on.
    const proof = share.cp !== undefined && share.cp >= 3 && share.accessSecret
      ? wasm.seatCertificateFromBundle(b.keyPackage, b.pubkeys, b.seat, b.t, b.n, share.cp, await deriveReadKey(share.accessSecret))
      : undefined
    const sent = await registerDeviceKeyResult(hex(share.groupKey), devicePubHex(b.keyPackage), {
      seat: b.seat,
      pub: deviceWriteKeyHex(b.keyPackage),
    }, proof, reportedFeeFrom())
    if ('failure' in sent) {
      const code = sent.failure?.code
      if (share.cp !== undefined && share.cp >= 3 && code) {
        noteSeatRefused(vaultId, 'registration.seatRefused', code)
        return { refused: code }
      }
      console.error('[konclave] this device could not register its seat with the coordinator', {
        vault: vaultId.slice(0, 8), seat: b.seat,
      })
      // #821: a REFUSAL is shown, not only logged. The seat is then without a device on record, so
      // this device cannot sign or vote until it is. A coordinator that did not answer is not one.
      const f = sent.failure
      if (f && f.status >= 400 && f.status < 500) noteSeatRefused(vaultId, seatRefusalKey(f.error))
      return false
    }
    noteSeatRegistered(vaultId)
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
