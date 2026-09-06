// Opening the hybrid seal-to-many envelope (#481), as ONE implementation.
//
// #63 built this for the signing request and it lived inside `unsealSignRequest`, wrapped in that
// message's own rules. Sealing the viewing key needs the identical three steps, and a second copy of
// a wire format is the worst kind to have: both ends must agree byte for byte, and a drift shows up
// as "wrong key or tampering" with no way to tell which end is wrong.
//
// The Rust side is `orchestrator::envelope`, which the helper and the signing path both build with.

import { hexToBytes } from './bytes'
import { openBody } from './wasm-pkg/konclave_wasm.js'

/** The slice of a device key this needs, named so a test can drive it without WASM. */
export interface Opener {
  open: (sealed: Uint8Array, aad: Uint8Array) => Uint8Array
}

export interface SealedEnvelope {
  kind: string
  body: string
  boxes: Record<string, string>
}

/** Is `o` an envelope of `kind`? Narrow rather than trusting a field, because the caller decides
 *  what a non-envelope means and must be able to tell without a throw. */
export function asEnvelope(o: unknown, kind: string): SealedEnvelope | null {
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (r.kind !== kind || typeof r.body !== 'string') return null
  if (typeof r.boxes !== 'object' || r.boxes === null) return null
  return r as unknown as SealedEnvelope
}

/**
 * Open the box addressed to `devicePubHex` and return the plaintext, or `null`.
 *
 * `null` covers every failure the same way on purpose - no box for this device, a tampered body, a
 * wrong key - because the caller can do nothing different about any of them, and a thrown error
 * here would have to be caught and flattened at each call site anyway.
 *
 * The AAD is the device pubkey bytes, matching what the sealer used: it is what stops a box being
 * lifted out of one device's slot and replayed into another's.
 */
export function openEnvelope(
  env: SealedEnvelope,
  key: Opener,
  devicePubHex: string,
): Uint8Array | null {
  const mine = env.boxes[devicePubHex]
  if (typeof mine !== 'string') return null
  try {
    // Hybrid: open my small box for the 32-byte body key, then decrypt the shared body with it.
    const bodyKey = key.open(hexToBytes(mine), hexToBytes(devicePubHex))
    return openBody(bodyKey, hexToBytes(env.body))
  } catch {
    return null
  }
}
