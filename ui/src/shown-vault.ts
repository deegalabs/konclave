// Which vault the UI is inside, and the ONE guard that says whether a screen may still act on the
// vault it showed. The selection is stored where every tab of a browser shares it and is read afresh,
// so a screen compares its own id against it once, at the moment it acts, and uses its own id from
// then on. Two screens had each their own way of asking; this is the only place that answers.
import { NET_AT_LOAD } from './helper'

// Persisted so a reload stays in the same vault; sent as ?vault=<id> so the bridge scopes data per
// vault (not always the first).
const VAULT_KEY = 'konclave.selectedVault'
export function setSelectedVault(id: string): void {
  try { localStorage.setItem(VAULT_KEY, id) } catch { /* storage unavailable */ }
}
export function getSelectedVault(): string | null {
  try { return localStorage.getItem(VAULT_KEY) } catch { return null }
}
export function clearSelectedVault(): void {
  try { localStorage.removeItem(VAULT_KEY) } catch { /* storage unavailable */ }
}

/** The ONE answer to "may this screen still write to the vault it showed". The selection lives in
 *  storage that every tab of the browser shares, so it is compared here, once, before anything is
 *  read or sent, and the caller uses `id` from then on and never reads the selection again. */
export function shownVault(shown: string | null | undefined): { ok: true; id: string } | { ok: false; gone?: true } {
  if (!shown) return { ok: false }
  const sel = getSelectedVault()
  const NET = NET_AT_LOAD
  // Removing a vault clears the selection that named it (`remove-vault.ts`): none on the web path
  // means the vault this screen showed is no longer in this browser.
  if (NET && sel === null) return { ok: false, gone: true }
  // The local bridge may run with no selection (it serves its own vault); the web path may not.
  if (NET ? sel !== shown : sel !== null && sel !== shown) return { ok: false }
  return { ok: true, id: shown }
}

/** The sentence for a refusal of `shownVault`, in one place: `gone` says only that this browser has no
 *  vault open now (the tab that cleared it may have removed another vault), `changed` that another
 *  vault is open. `where` picks the screen's wording. */
export function refusalKey(r: { gone?: boolean }, where: 'settings' | 'payment'): string {
  return `${where}.${r.gone ? 'vaultGone' : 'vaultChanged'}`
}

/** The error text of a refusal of `shownVault`: the ONE producer. */
export function refusalError(s: { gone?: boolean }): 'vault gone' | 'vault changed' {
  return s.gone ? 'vault gone' : 'vault changed'
}
/** The refusal an error text names, or null when it names none: the ONE reader of `refusalError`. */
export function refusalFromError(error: string | undefined): { gone?: true } | null {
  return error === 'vault gone' ? { gone: true } : error === 'vault changed' ? {} : null
}

/** `?vault=<id>` for a write: the shown vault's id, never the selection, which the bridge would read afresh. */
export const vaultQuery = (path: string, id: string) => `${path}?vault=${encodeURIComponent(id)}`

/** An answer about a vault is used only when it is about the one the screen is pinned to (no pin: any).
 *  The one place that comparison lives. */
export function pinnedAnswer<T extends { id: string }>(pinned: string | null, got: T | null): T | null {
  return got && (!pinned || got.id === pinned) ? got : null
}
