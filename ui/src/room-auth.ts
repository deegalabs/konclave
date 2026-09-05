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

// ---- the tally messages (#425) ----
//
// `rejoin` was signed by #392/#401; `armed` and `unarmed` were left plain, and they are what
// carries the count of who has signed a payment. Anyone who could write to the room could post
// `unarmed` and clear every device's tally, repeatedly, so a payment never reached a quorum - or
// forge `armed` for absent seats until the panel named a sender that would never send. No money
// moves either way (the ceremony still needs real shares): this is availability.
//
// Both bind the SEAT, the VAULT, the TAG, the PROPOSAL and the payload, for the same reason the
// rejoin binds its tag: a captured message must not be replayable under another tag, for another
// payment, or in another vault. The free-length field goes LAST in every one of these, so no two
// distinct field sets can encode to the same bytes.

/** The canonical bytes an `armed` signs. `at` is inside it: without that, an old arming could be
 *  re-published with a fresh timestamp to keep a departed seat counted past its expiry. */
function armedMessage(seat: number, groupVkHex: string, tag: string, at: number, proposal: string): Uint8Array {
  return new TextEncoder().encode(
    `armed:${seat}:${groupVkHex.trim().toLowerCase()}:${tag}:${at}:${proposal}`,
  )
}

/** The canonical bytes an `unarmed` signs. The failure code is inside it so it cannot be swapped
 *  for a different reason in flight - each device writes its own sentence from that code. */
function unarmedMessage(seat: number, groupVkHex: string, tag: string, code: string, proposal: string): Uint8Array {
  return new TextEncoder().encode(
    `unarmed:${seat}:${groupVkHex.trim().toLowerCase()}:${tag}:${code}:${proposal}`,
  )
}

/** Sign this device's `armed`. Hex signature. */
export function signArmed(
  keyPackage: Uint8Array, seat: number, groupVkHex: string, tag: string, at: number, proposal: string,
): string {
  return bytesToHex(signRoomMsg(keyPackage, armedMessage(seat, groupVkHex, tag, at, proposal)))
}

/** Sign this device's `unarmed`. `code` absent is signed as `-`, so "no reason given" is itself
 *  a signed fact rather than a field an attacker can add. */
export function signUnarmed(
  keyPackage: Uint8Array, seat: number, groupVkHex: string, tag: string, proposal: string, code?: string,
): string {
  return bytesToHex(signRoomMsg(keyPackage, unarmedMessage(seat, groupVkHex, tag, code ?? '-', proposal)))
}

/** Is this `armed` a real announcement by that seat's share-holder? Never throws. */
export function armedIsProven(
  mat: RoomMaterial, seat: number, tag: string, at: number, proposal: string, sig: unknown,
): boolean {
  if (typeof sig !== 'string') return false
  try {
    return verifyRoomSig(
      mat.pubkeys, seat, armedMessage(seat, bytesToHex(mat.groupVk), tag, at, proposal), hexToBytes(sig),
    )
  } catch {
    return false
  }
}

/** Is this `unarmed` a real withdrawal by that seat's share-holder? Never throws. */
export function unarmedIsProven(
  mat: RoomMaterial, seat: number, tag: string, proposal: string, code: unknown, sig: unknown,
): boolean {
  if (typeof sig !== 'string') return false
  const c = typeof code === 'string' ? code : '-'
  try {
    return verifyRoomSig(
      mat.pubkeys, seat, unarmedMessage(seat, bytesToHex(mat.groupVk), tag, c, proposal), hexToBytes(sig),
    )
  } catch {
    return false
  }
}
