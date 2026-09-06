// In-memory session store for the DECRYPTED device share (redesign Fase 1, access model).
//
// The share lives encrypted at rest in IndexedDB (storage.ts). "Unlocking" a vault decrypts it
// once, for this session, and holds the plaintext here in memory only, keyed by vault id (the group
// key hex). The Dashboard/governance read public helper data and do not need it; the signing
// ceremony (/net) reads it from here instead of prompting for the passphrase again. Cleared on
// lock/remove; never written to disk (that is storage.ts's encrypted job).

import type { VaultLoaded } from './storage'

const unlocked = new Map<string, VaultLoaded>()

/** Record the freshly-decrypted share for `id` (the group key hex) for this session. */
export function setUnlockedShare(id: string, v: VaultLoaded): void {
  unlocked.set(id, v)
}

/** The decrypted share for `id`, if it was unlocked this session; otherwise undefined. */
export function getUnlockedShare(id: string): VaultLoaded | undefined {
  return unlocked.get(id)
}

/** Drop the in-memory share (on lock, remove, or switch away). */
export function clearUnlockedShare(id: string): void {
  unlocked.delete(id)
}

// ---- the read secret, held on its own (#446 C) ----
//
// `S` gates the helper's private reads (#388). It normally arrives INSIDE the unlocked share, but a
// PRF unlock produces it WITHOUT the share: a touch gives you the vault's books, and moving money
// still asks for the passphrase. That separation is the whole point - reading a vault should not
// cost what spending does - so `S` needs somewhere to live that is not the share.
//
// In memory like everything here. The encrypted wrap on disk is what survives a reload; this is
// only what the current page has opened.

const readSecrets = new Map<string, Uint8Array>()

/** Record `S` for this session, obtained WITHOUT the share (a PRF unlock). */
export function setReadSecret(id: string, s: Uint8Array): void {
  readSecrets.set(id, s)
}

/**
 * `S` for `id`, from whichever source this session has: the unlocked share if the passphrase was
 * given, otherwise a standalone one from a PRF unlock.
 *
 * Every caller that needs the read token must use THIS and not reach into the share directly, or
 * a PRF-unlocked vault would read as locked - the same class of bug as #439, where two notions of
 * "unlocked" drifted and the guard checked the wrong one.
 */
export function readSecretFor(id: string): Uint8Array | undefined {
  return unlocked.get(id)?.accessSecret ?? readSecrets.get(id)
}

/** Drop both, on lock or removal. */
export function clearReadSecret(id: string): void {
  readSecrets.delete(id)
}
