// The per-vault access secret S (#388). A leaked vault id is the public group verifying key, so on
// its own it currently opens the helper's reads and lets anyone compute the signing room. S closes
// that: every seated member holds it, an id-only outsider does not.
//
// S is FRESH RANDOMNESS, not derived from the DKG. Every value the DKG produces is either public
// (the group key, the verifying shares) or crosses the relay in the clear (the round1 packages the
// PublicKeyPackage is derived from), so anything DKG-derived would be known to the relay. The
// creator mints S once at vault creation and seals it to each member via the #63 device comms keys;
// each member persists it sealed under their passphrase (see storage.ts `accessSecret`).
//
// This module is the home for S: minting it here, and (in later #388 steps) deriving the signing
// room and the helper read token from it.

/** Length of the access secret in bytes (256-bit). */
export const VAULT_SECRET_BYTES = 32

/** Mint a fresh access secret. Called once by the creator when a vault is set up. */
export function generateVaultSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(VAULT_SECRET_BYTES))
}

/**
 * The helper read token: `readKey = HKDF-SHA256(S, info="konclave-read-v1")` (#388 Passo 2).
 *
 * Domain-separated from S so a leaked read token (e.g. a value logged in a request header) reveals
 * neither S nor anything derived from it for the signing room. The client sends this once at
 * registration; the helper stores it and constant-time compares it on every read. A vault with no
 * stored readKey keeps accepting reads without a token (pre-#388 compat), so migration is per-vault.
 */
export async function deriveReadKey(secret: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', bufOf(secret), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('konclave-read-v1'),
    },
    base,
    256,
  )
  return new Uint8Array(bits)
}

/** A fresh ArrayBuffer view of `b` (crypto.subtle wants a plain BufferSource). */
function bufOf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
