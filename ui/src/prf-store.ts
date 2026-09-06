// Where a device keeps its PRF wrap (#446 C).
//
// Deliberately NOT in the vault record. The record is what `exportVault` serialises, and this wrap
// is the one thing in the product that must never travel: it is bound to an authenticator on THIS
// machine, and a copy on another device is at best useless and at worst a wrap that looks like a
// way in and is not. Keeping it in a separate place makes that structural rather than a rule
// someone has to remember when they touch the export.
//
// `localStorage` and not IndexedDB because it must survive the reload that this whole feature
// exists for, and because there is nothing secret in it: the blob is AES-GCM under a key only the
// authenticator can produce. Losing it costs a member one passphrase entry.

import type { PrfWrap } from './prf-wrap'

const KEY = (vaultId: string) => `konclave.prf.${vaultId}`

/** The wrap this device stored for `vaultId`, or null. Never throws: storage can be unavailable. */
export function loadPrfWrap(vaultId: string): PrfWrap | null {
  try {
    const raw = localStorage.getItem(KEY(vaultId))
    if (!raw) return null
    const w = JSON.parse(raw) as Partial<PrfWrap>
    return w.credentialId && w.salt && w.iv && w.cipher ? (w as PrfWrap) : null
  } catch {
    return null
  }
}

/** Store it. Best-effort: a failure means the member types their passphrase next time, nothing more. */
export function savePrfWrap(vaultId: string, wrap: PrfWrap): void {
  try {
    localStorage.setItem(KEY(vaultId), JSON.stringify(wrap))
  } catch {
    /* private mode, quota, storage blocked - all the same answer: no shortcut, no harm */
  }
}

/** Forget it. Called when the member turns the shortcut off, and whenever the vault is removed
 *  from this device - a wrap outliving its vault is litter that can only confuse. */
export function clearPrfWrap(vaultId: string): void {
  try {
    localStorage.removeItem(KEY(vaultId))
  } catch {
    /* nothing to do and nothing at stake */
  }
}
