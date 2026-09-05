// Authenticating signing-room writes (#392). A device signs its room announcements with its FROST
// SHARE (domain-separated, so a room signature can never be a transaction spend-auth signature); any
// device verifies against that seat's public `verifying_share` from the DKG PublicKeyPackage it
// already holds. No trusted registry: the seat's identity IS its verifying_share, so an outsider who
// knows the room but not a seat's share cannot forge that seat.

import { signRoomMsg, verifyRoomSig } from './wasm-pkg/konclave_wasm.js'
import { bytesToHex, hexToBytes } from './bytes'

/** The canonical bytes a rejoin signs. Binding the SEAT, the VAULT (group key), and the relay TAG
 *  means a valid signature proves the seat's share-holder is at THIS tag in THIS vault - so a
 *  captured rejoin cannot be replayed under a different tag to hijack the seat. */
function rejoinMessage(seat: number, groupVkHex: string, tag: string): Uint8Array {
  return new TextEncoder().encode(`rejoin:${seat}:${groupVkHex.trim().toLowerCase()}:${tag}`)
}

/** Sign this device's rejoin with its share. Hex signature. */
export function signRejoin(keyPackage: Uint8Array, seat: number, groupVkHex: string, tag: string): string {
  return bytesToHex(signRoomMsg(keyPackage, rejoinMessage(seat, groupVkHex, tag)))
}

/** Is `sigHex` a signature by SEAT `seat`'s share over this (seat, vault, tag)? False on any bad
 *  input, so an unverifiable rejoin is simply treated as unproven (it may seat an empty seat but
 *  never evict an established one - see SigningSeats.handleRejoin). */
export function verifyRejoin(
  pubkeys: Uint8Array,
  seat: number,
  groupVkHex: string,
  tag: string,
  sigHex: string,
): boolean {
  try {
    return verifyRoomSig(pubkeys, seat, rejoinMessage(seat, groupVkHex, tag), hexToBytes(sigHex))
  } catch {
    return false
  }
}

/** The public material a device needs to judge someone else's rejoin. Both drivers already hold
 *  exactly this (their `signingMaterial()`), which is why the check can be shared whole. */
export interface RoomMaterial {
  groupVk: Uint8Array
  pubkeys: Uint8Array
}

/**
 * Is this rejoin PROVEN - carrying a real signature by that seat's own share?
 *
 * The whole decision lives here, hex conversion included, because the two ceremony drivers used to
 * each own a piece of it and one of them never got the check at all (#424). A caller that only
 * shared `verifyRejoin` could still pass the group key and the tag in the wrong order and be
 * wrong in a way no test would see. Never throws: a malformed or absent signature is unproven,
 * which is the safe side (an unproven rejoin may seat an EMPTY seat but never evicts a holder).
 */
export function rejoinIsProven(
  mat: RoomMaterial,
  seat: number,
  tag: string,
  sig: unknown,
): boolean {
  if (typeof sig !== 'string') return false
  return verifyRejoin(mat.pubkeys, seat, bytesToHex(mat.groupVk), tag, sig)
}
