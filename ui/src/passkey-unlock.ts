// Opening a vault with the passkey shortcut, and the ONE place it happens.
//
// #469 unified the BUTTON across the two unlock surfaces and left the handler behind it duplicated:
// `LockOverlay.withPasskey` and `Vaults.unlockWithPasskey` were the same twelve lines in two files.
// Two implementations of one rule, with only one of them fixed, is the failure this repo keeps
// meeting - so the handler moves here and a test holds it here.
//
// WHAT "SILENT" WAS SUPPOSED TO MEAN. The rule in `prf-wrap.ts` is that a failure to OPEN costs
// nothing: "the caller asks for the passphrase exactly as it does today". The intent is that the
// member is never handed an error to interpret. What shipped was different and worse: the button
// said "Waiting for this device..." for up to a minute and then went back to normal, having said
// nothing and changed nothing. That does not read as "use your passphrase", it reads as broken.
//
// So the silence is kept where it belongs - no alarming copy, nothing the member must act on - and
// the two things that were missing are added: a quiet sentence pointing at the passphrase that is
// already on screen, and a console line so the failure can be DIAGNOSED. Neither costs the member
// anything, and the second one is the difference between a bug report and a screenshot.
import { loadPrfWrap } from './prf-store'
import { openPrf, isPrfOpenDenial, type PrfOpenDenial } from './prf-wrap'
import { setReadSecret } from './session'
import { markVaultUnlocked } from './api'

/**
 * How long to wait for the authenticator before giving up.
 *
 * Shorter than enrolment's, deliberately. Enrolling asks the member to read a system sheet and
 * decide; opening is a touch they either give at once or do not give at all. A minute of a spinning
 * button is not patience, it is a screen that looks stuck.
 */
export const UNLOCK_TIMEOUT_MS = 25_000

export type PasskeyUnlock =
  /** `S` is in the session and the vault is marked unlocked. */
  | 'unlocked'
  /** No wrap on this device - the caller should not have offered the button. */
  | 'no-wrap'
  /** It did not open, and WHICH of the four it was. The screen still shows one quiet sentence;
   *  this is what sits behind the "details" tap, because the device that fails is a phone and a
   *  phone has no console. */
  | PrfOpenDenial

export interface PasskeyUnlockDeps {
  loadPrfWrap: typeof loadPrfWrap
  openPrf: typeof openPrf
  setReadSecret: typeof setReadSecret
  markVaultUnlocked: typeof markVaultUnlocked
}

const REAL: PasskeyUnlockDeps = { loadPrfWrap, openPrf, setReadSecret, markVaultUnlocked }

export async function unlockWithPasskeyUsing(
  deps: PasskeyUnlockDeps,
  vaultId: string,
  rpId: string,
  auth: Parameters<typeof openPrf>[0],
): Promise<PasskeyUnlock> {
  const wrap = deps.loadPrfWrap(vaultId)
  if (!wrap) return 'no-wrap'
  const s = await deps.openPrf(auth, wrap, rpId, UNLOCK_TIMEOUT_MS)
  if (isPrfOpenDenial(s)) {
    // Logged as well as returned. The console is the right place when there IS one; the returned
    // reason is what a phone can show, and a phone is where this always fails - the shortcut is
    // per device by design.
    console.error('[konclave] the passkey did not open this vault; the passphrase still does', {
      vaultId, rpId, reason: s, waitedMs: UNLOCK_TIMEOUT_MS,
    })
    return s
  }
  deps.setReadSecret(vaultId, s)
  deps.markVaultUnlocked(vaultId)
  return 'unlocked'
}

/** `unlockWithPasskeyUsing` against the real storage and session. What the screens call. */
export function unlockWithPasskey(vaultId: string): Promise<PasskeyUnlock> {
  return unlockWithPasskeyUsing(REAL, vaultId, location.hostname, navigator.credentials)
}
