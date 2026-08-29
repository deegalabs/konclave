// A device's persistent comms identity for a vault (#63 / ADR-0007 I3).
//
// Derived deterministically from the device's FROST share (the KeyPackage), so it is reproduced on
// every unlock with NOTHING stored: no new sealed blob, no IndexedDB migration that touches the
// crown-jewel sealed share. The PUBLIC half is what a device registers with the helper so the helper
// can SEAL the SignRequest to it - the relay then carries only ciphertext, closing the metadata leak
// H2 (today the request is posted in cleartext and decodes to recipient + amount). The secret half is
// derived on demand to OPEN a sealed request; it never leaves WASM.

import { DeviceKey } from './wasm-pkg/konclave_wasm.js'
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
