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
