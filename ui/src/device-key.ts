// A device's persistent comms identity for a vault (#63 / ADR-0007 I3).
//
// Derived deterministically from the device's FROST share (the KeyPackage), so it is reproduced on
// every unlock with NOTHING stored: no new sealed blob, no IndexedDB migration that touches the
// crown-jewel sealed share. The PUBLIC half is what a device registers with the helper so the helper
// can SEAL the SignRequest to it - the relay then carries only ciphertext, closing the metadata leak
// H2 (today the request is posted in cleartext and decodes to recipient + amount). The secret half is
// derived on demand to OPEN a sealed request; it never leaves WASM.

import { DeviceKey, deviceWritePubHex, signWrite } from './wasm-pkg/konclave_wasm.js'
import { bytesToHex } from './bytes'

/** This device's persistent comms keypair for the vault, from its share (the serialized KeyPackage
 *  in `signingMaterial().keyPackage`). Stable across reloads; different for every device/seat. */
export function deviceCommsKey(keyPackage: Uint8Array): DeviceKey {
  return DeviceKey.fromShare(keyPackage)
}

/** The registerable public identity: hex of the 32-byte X25519 public key. This is what the device
 *  hands the helper so a SignRequest can be sealed to it. */
export function devicePubHex(keyPackage: Uint8Array): string {
  return bytesToHex(deviceCommsKey(keyPackage).publicBytes())
}

// ---- the WRITE identity (#288 / ADR-0011 D1) ----
//
// The same share, a different HKDF label: X25519 for sealing above, Ed25519 for signing governance
// writes here. Two sub-keys of one device identity; the FROST share stays reserved for the
// threshold signature and nothing else, which is the hygiene `frost-client` follows.
//
// Both halves live in WASM. The secret is derived inside `signWrite` for the length of one call and
// never reaches JS - so there is no place in this file, or any other, where it could be logged.

/** This device's Ed25519 write-verifying key for the vault, hex. The public half, to register. */
export function deviceWriteKeyHex(keyPackage: Uint8Array): string {
  return deviceWritePubHex(keyPackage)
}

/** What a signed governance write carries on the wire, beside the action's own fields. */
export interface WriteProof {
  seat: number
  ts: number
  nonce: string
  sig: string
}

/**
 * Sign a governance write. `action` is 'approve' | 'refuse' | 'rename'; `target` is the proposal id,
 * or `old\0new` for a rename.
 *
 * The canonical bytes are built inside WASM, by the same Rust function the helper verifies with, so
 * the format cannot drift between the two. Nothing here assembles it - deliberately.
 */
export function signGovernanceWrite(
  keyPackage: Uint8Array,
  vaultId: string,
  action: 'approve' | 'refuse' | 'rename',
  target: string,
  seat: number,
): WriteProof {
  const ts = Date.now()
  // Single-use per vault, and the helper keeps the used set. Random rather than a counter: a
  // counter would need state this device deliberately does not keep, and two devices sharing a
  // seat's history would collide.
  const nonce = crypto.randomUUID()
  return { seat, ts, nonce, sig: signWrite(keyPackage, vaultId, action, target, seat, ts, nonce) }
}
