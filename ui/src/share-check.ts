// Does a saved share belong to this seat of this vault? The device-side door to the one rule.
//
// The rule is `check_share_bundle` in konclave-wasm: the key package against the group's public
// package (seat, group key in both, quorum, the public share recorded for the seat, and that the
// signing share derives it). This file only reads the device bundle, hands its parts to that rule
// and turns a refusal into a storage error. Import (both export versions) and `loadVault`, the one
// place a sealed share is opened, call it; nothing here is a second implementation of the check.

import { checkShareBundle } from './wasm-pkg/konclave_wasm.js'
import { ensureWasm } from './wasm-ready'
import { unb64 } from './bytes'
import { storageError } from './storage-errors'

const REFUSAL = 'This share does not belong to this seat of this vault'

/** Throws `wrong-seat` unless `bundle` (the device bundle's bytes) is the share of its seat of the
 *  vault whose group key is `groupKey`. Anything unreadable is a refusal too. */
export async function assertShareIsThisSeats(bundle: Uint8Array, groupKey: Uint8Array): Promise<void> {
  let kp: Uint8Array
  let pubkeys: Uint8Array
  let seat: unknown
  let t: unknown
  try {
    const b = JSON.parse(new TextDecoder().decode(bundle)) as { kp?: unknown; pubkeys?: unknown; seat?: unknown; t?: unknown }
    if (typeof b.kp !== 'string' || typeof b.pubkeys !== 'string') throw new Error('not a bundle')
    kp = unb64(b.kp)
    pubkeys = unb64(b.pubkeys)
    seat = b.seat
    t = b.t
  } catch {
    throw storageError('wrong-seat', REFUSAL)
  }
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 0xffff
  if (!whole(seat) || !whole(t)) throw storageError('wrong-seat', REFUSAL)
  await ensureWasm()
  try {
    checkShareBundle(kp, pubkeys, seat, groupKey, t)
  } catch {
    // The wasm throws a short code (which part disagreed); a member needs only that it is not theirs.
    throw storageError('wrong-seat', REFUSAL)
  }
}
