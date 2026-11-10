// Shared FROST signing primitives - the reusable core of the /net signing ceremony, factored out
// of NetVault so the same implementation can also run as an app-level background signer (one source
// of truth, never a fork of the proven money path). Stage 0 of ADR-0006 Rung B: pure helpers only,
// no behavior change; the stateful SigningMachine follows in a later stage.

import { extractRandomizers, groupKeyOfPackage } from './wasm-pkg/konclave_wasm.js'
import { bytesEqual, unb64 } from './net'
import type { VaultLoaded } from './storage'

/** One real spend to authorize: its on-chain action index + the 32-byte Orchard randomizer (alpha). */
export interface SpendAlpha {
  index: number
  alpha: Uint8Array
}

/**
 * Parse EVERY real spend the proven PCZT must sign. `extractRandomizers` returns 36-byte records
 * (u32 little-endian action index + 32-byte alpha); a multi-note tx yields several, each its own
 * ceremony. Indices come straight from the PCZT so each signature maps to the exact on-chain spend
 * the helper's `into_sigs` expects. (Moved verbatim from NetVault's `alphasFromPczt`.)
 *
 * `groupVk` is the vault's group key as THIS device holds it (`deviceGroupKey`), never a value from
 * the wire: each spend is checked against it before the device takes part, and a transaction with
 * a spend that is not under it is refused whole.
 */
export function parseAlphas(pczt: Uint8Array, groupVk: Uint8Array): SpendAlpha[] {
  const rand = extractRandomizers(pczt, groupVk)
  const out: SpendAlpha[] = []
  for (let off = 0; off + 36 <= rand.length; off += 36) {
    const index = rand[off]! | (rand[off + 1]! << 8) | (rand[off + 2]! << 16) | (rand[off + 3]! << 24)
    out.push({ index: index >>> 0, alpha: rand.slice(off + 4, off + 36) })
  }
  return out
}

/** The vault key this device signs under: the key of its saved package, which must be the one on
 *  record for the vault. A device whose two disagree has nothing it can safely check against. */
export function deviceGroupKey(mat: { pubkeys: Uint8Array; groupVk: Uint8Array }): Uint8Array {
  const own = groupKeyOfPackage(mat.pubkeys)
  if (!bytesEqual(own, mat.groupVk)) throw new Error("[vaultkey] the vault key on record is not the key of the package this device signs under")
  return own
}

/** The per-device signing material recovered from an unlocked vault - everything a ceremony needs. */
export interface RestoredShare {
  keyPackage: Uint8Array
  pubkeys: Uint8Array
  groupVk: Uint8Array
  seat: number
  n: number
  t: number
}

/**
 * Decode the sealed bundle of an unlocked vault into signing material. Signing needs only the
 * KeyPackage, the group PublicKeyPackage, and this device's seat (older bundles carry a field that nothing reads).
 * (Moved verbatim from NetVault's `applyLoaded` inline decode.)
 */
export function decodeBundle(v: VaultLoaded): RestoredShare {
  const bundle = JSON.parse(new TextDecoder().decode(v.sealedShare)) as {
    kp: string
    pubkeys: string
    seat: number
    n: number
    t: number
  }
  return {
    keyPackage: unb64(bundle.kp),
    pubkeys: unb64(bundle.pubkeys),
    groupVk: v.groupKey,
    seat: bundle.seat,
    n: bundle.n,
    t: bundle.t,
  }
}
