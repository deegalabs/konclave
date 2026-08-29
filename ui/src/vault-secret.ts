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
