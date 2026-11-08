// The digest of this device's own package, which a coordinator's answer is held to.
import type { VaultLoaded } from './storage'
import { decodeBundle } from './signing'
import { ensureWasm } from './wasm-ready'
import { pkpDigestHex } from './wasm-pkg/konclave_wasm.js'

export async function ownPkpDigest(share: VaultLoaded, threshold: number, total: number): Promise<string> {
  await ensureWasm()
  return pkpDigestHex(decodeBundle(share).pubkeys, threshold, total)
}
