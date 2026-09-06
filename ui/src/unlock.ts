// Opening a vault's share on THIS device - the one implementation of it.
//
// It lived only inside the picker's `doUnlock`, so the in-place lock overlay (#467) would have been
// a second copy of the same six lines. That is the shape this repo keeps paying for: one rule, two
// implementations, and only one of them updated. The picker and the overlay both call this.
//
// Deliberately NOT included: where to go afterwards. The picker navigates, the overlay dismisses
// itself, and a shared function that also routed would force one of them to lie.

import { unlockVault, markVaultUnlocked } from './api'
import { loadVault } from './storage'
import { setUnlockedShare } from './session'

/** Where a vault lives, and therefore how its unlock works. Mirrors the picker's `Src`. */
export type VaultSrc = 'net' | 'local'

/**
 * `wrong` separates a bad passphrase from a failure that is not the member's fault. Telling someone
 * their passphrase is wrong when the bridge is down sends them hunting for a mistake they did not
 * make, and on a vault whose passphrase is the only key to a share, that is a cruel thing to get
 * backwards.
 */
export type UnlockResult = { ok: true } | { ok: false; wrong: boolean }

/** The side of the app `unlockWith` touches, named so a test can drive it without a browser - the
 *  same shape `prf-wrap.ts` uses for `Authenticator`, and for the same reason. */
export interface UnlockDeps {
  loadVault: typeof loadVault
  setUnlockedShare: typeof setUnlockedShare
  markVaultUnlocked: typeof markVaultUnlocked
  unlockVault: typeof unlockVault
}

/**
 * Decrypt this device's material for `id` and put it in the session.
 *
 * For a browser-native (`net`) vault that material is the share, and `readSecretFor` reads `S` out
 * of it - so this one call is what makes the helper's private reads authenticate. Anything that
 * skipped `setUnlockedShare` would look unlocked and 401 on every read.
 */
export async function unlockWith(
  deps: UnlockDeps,
  id: string,
  src: VaultSrc,
  pass: string,
): Promise<UnlockResult> {
  if (!pass) return { ok: false, wrong: true }
  try {
    if (src === 'net') {
      const share = await deps.loadVault(id, pass)
      deps.setUnlockedShare(id, share)
      deps.markVaultUnlocked(id)
      return { ok: true }
    }
    const r = await deps.unlockVault(pass)
    if (r.ok) {
      deps.markVaultUnlocked(id)
      return { ok: true }
    }
    // The bridge already told us WHICH kind of failure this is. Passing its answer through, rather
    // than collapsing every failure to "wrong passphrase", is the whole point of the flag.
    return { ok: false, wrong: !!r.wrong }
  } catch {
    // The seal refused to open, which on a `net` vault is the passphrase - the only thing the
    // member can act on.
    return { ok: false, wrong: true }
  }
}

const REAL: UnlockDeps = { loadVault, setUnlockedShare, markVaultUnlocked, unlockVault }

/** `unlockWith` against the real storage/session/bridge. What the app calls. */
export function unlockOnDevice(id: string, src: VaultSrc, pass: string): Promise<UnlockResult> {
  return unlockWith(REAL, id, src, pass)
}
