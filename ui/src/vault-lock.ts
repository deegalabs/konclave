// Whether this device can read a vault's private data, or has to unlock it first (#439).
//
// The app grew TWO notions of "unlocked" and the route guard was left holding the older one:
//
//   • `Vault.locked` + `isVaultUnlocked(id)` - the local bridge's notion, from before browser
//     vaults existed.
//   • `getUnlockedShare(id)?.accessSecret` - the per-vault secret S (#388), which is what
//     `readAuthHeaders` turns into the `X-Konclave-Read` token the helper's private reads require.
//
// A browser-native vault never sets `locked`, so `v?.locked && !isVaultUnlocked(v.id)` was always
// false for one and the guard never fired. A member could walk into a protected vault's dashboard
// holding no S - a page reload was enough, since the session is in memory - and every private read
// came back 401 into a screen that showed nothing and explained nothing.
//
// This is the question both guards should have been asking, in ONE place, because the defect was
// precisely two implementations of one rule with only one of them taught about the new world.

export interface LockState {
  /** `Vault.locked`: the bridge's own flag. Absent on browser-native vaults. */
  bridgeLocked?: boolean
  /** `isVaultUnlocked(id)`: unlocked through the picker in THIS browser session. */
  unlockedThisSession: boolean
  /** This device holds a local record for the vault whose share is sealed with an S (#388).
   *  `undefined` when there is no local record at all, which is a different situation. */
  securedLocally?: boolean
  /** `getUnlockedShare(id)?.accessSecret` is present: the reads can be authenticated. */
  hasAccessSecret: boolean
}

/**
 * Must this device unlock the vault before its private reads can work?
 *
 * Both historical cases are kept, because both are real:
 *
 *  1. The bridge says the vault is locked and it was not unlocked this session. Unchanged.
 *  2. **New:** this device holds a protected (#388) record for it and no S in memory. This is the
 *     one the old guard missed, and the one a reload produces.
 *
 * Deliberately NOT true when there is no local record (`securedLocally === undefined`). Such a
 * device cannot unlock the vault at all, so routing it to the unlock picker would offer a door it
 * cannot open, and could bounce it back and forth. Its reads may still 401, and saying so honestly
 * is the separate, wider fix: today every private read collapses a 401 into `null`, which reads
 * identically to an empty vault.
 */
export function needsUnlock(s: LockState): boolean {
  if (s.bridgeLocked && !s.unlockedThisSession) return true
  if (s.securedLocally === true && !s.hasAccessSecret) return true
  return false
}

/**
 * Does this device hold a **protected** (#388) local record for `id`?
 *
 * `undefined` when there is no local record at all - which `needsUnlock` treats differently from
 * `false`, because "this vault is open" and "this device holds nothing of it" are not the same
 * answer. Storage failures degrade to `undefined` for the same reason: not knowing is not the same
 * as knowing it is open, and guessing "open" here would walk the member into the blank screen this
 * whole rule exists to prevent.
 */
export async function securedLocally(id: string): Promise<boolean | undefined> {
  try {
    const { listVaults } = await import('./storage')
    const rec = (await listVaults()).find((v) => v.id === id)
    return rec ? !!rec.secured : undefined
  } catch {
    return undefined
  }
}
