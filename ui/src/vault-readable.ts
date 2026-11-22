// Whether a screen inside the vault may make its private reads yet (#439, #467).
//
// A locked vault is not a failed read. Behind the unlock overlay every private read answers 401, and
// a screen that reads at mount turned that into "Could not read the proposals" - or, where a 401
// collapses to null, an empty book. `Layout` decides the lock with `needsUnlock` and shows the
// overlay, but its `locked` starts false and lands after its own reads, so a screen that only
// watched it still read first. This asks the same rule, for the screen, before its first read, and
// again each time the overlay's passphrase lands (`unlockNonce`).
import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { IS_NET, getSelectedVault, getVault, isVaultUnlocked } from './api'
import { readSecretFor } from './session'
import { needsUnlock, securedLocally } from './vault-lock'
import { readVaults } from './storage'
import type { VaultLockContext } from './Layout'

/** `needsUnlock` for a vault as the app holds it now: the inputs `Layout` gathers once the vault has answered. */
export async function lockedNow(v: { id: string; locked?: boolean } | null): Promise<boolean> {
  if (!v) return false // no vault answered: the screen's own read says so, not a lock
  return needsUnlock({
    bridgeLocked: v.locked,
    unlockedThisSession: isVaultUnlocked(v.id),
    securedLocally: await securedLocally(v.id),
    hasAccessSecret: !!readSecretFor(v.id),
  })
}

/**
 * The same rule from this device's own record, with no request (P0A). On the web a vault this device
 * holds a record of is decided here, so an app that is opened and not unlocked names the vault to
 * nobody: the lock needs only `secured` (is there a sealed S), the session, and the S in memory.
 *
 * `undefined` when this is not the browser-native app, or the device holds no record of `id`: the
 * bridge/helper path decides, as before.
 *
 * A storage that cannot be read answers LOCKED, which is not what `securedLocally` does (it answers
 * "no record", so a failing read opens). Here not knowing cannot be allowed to name the vault, and it
 * cannot loop: leaving the overlay goes to /vaults, which reads the same storage and says so (#320).
 */
export async function localLockNow(id: string): Promise<{ locked: boolean; name: string } | undefined> {
  if (!IS_NET) return undefined
  let rec: Awaited<ReturnType<typeof readVaults>>[number] | undefined
  try {
    rec = (await readVaults()).find((v) => v.id === id)
  } catch {
    return { locked: true, name: '' }
  }
  if (!rec) return undefined
  return {
    locked: needsUnlock({
      bridgeLocked: undefined,
      unlockedThisSession: isVaultUnlocked(id),
      securedLocally: !!rec.secured,
      hasAccessSecret: !!readSecretFor(id),
    }),
    name: rec.name ?? '',
  }
}

/**
 * False until the rule has answered, and while the vault is locked. A screen reads only when it is
 * true and lists it as its effect's dependency: each unlock turns it false and then true again, so
 * the screen reads once after it, with no nonce of its own to watch.
 * Outside `Layout` (a screen mounted on its own) there is no overlay context, and the rule alone
 * decides.
 */
export function useVaultReadable(): boolean {
  const ctx = useOutletContext<VaultLockContext | undefined>()
  const locked = !!ctx?.locked
  const unlockNonce = ctx?.unlockNonce ?? 0
  const [readable, setReadable] = useState(false)
  useEffect(() => {
    setReadable(false)
    if (locked) return
    let on = true
    // On the web the vault is the selected one and only the device knows its lock, so asking costs no
    // request; the bridge's own `locked` comes with its vault.
    const id = IS_NET ? getSelectedVault() : null
    const vault = IS_NET ? Promise.resolve(id ? { id } : null) : getVault().catch(() => null)
    void vault.then(lockedNow).then((l) => { if (on) setReadable(!l) })
    return () => { on = false }
  }, [locked, unlockNonce])
  return readable
}
