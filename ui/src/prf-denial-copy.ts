// Which sentence each enrolment denial gets (#538).
//
// Its own module, and not a literal inside `Settings.tsx`, for the reason this repo keeps
// relearning: a copy key is one rule with TWO implementations - the screen that names it and the
// locale files that define it - and the half that drifts is never the one being looked at. Here the
// map is exported, so a test can hold it against BOTH locales instead of a source scan guessing at
// a regex.
//
// `Record<PrfDenial, string>` is what makes it exhaustive: a denial added to the union fails the
// build here, rather than quietly falling back to the vague message that caused it in the first
// place.
import type { PrfDenial, PrfOpenDenial } from './prf-wrap'

export const DENIAL_COPY: Record<PrfDenial, string> = {
  // Permanent: this authenticator does not implement the PRF extension. The copy sends the member
  // to the passphrase rather than inviting a third attempt at something that cannot work.
  'no-prf': 'settings.passkeyNoPrf',
  // The platform never replied. The member did nothing wrong, so "try again" is honest here.
  unanswered: 'settings.passkeyNoAnswer',
  // Including the member pressing Escape, which is a choice, not an error.
  cancelled: 'settings.passkeyCancelled',
  // The remedy is OUTSIDE this app - the system's passkey manager - so this is the one message that
  // has to tell the member where to go, not just what happened.
  'already-enrolled': 'settings.passkeyExists',
}

/**
 * And the same for a wrap that did not OPEN.
 *
 * Four sentences rather than one plus a hidden "details", because the diagnosis has to be legible
 * ON THE SCREEN. The shortcut is per DEVICE by design, so the device that fails is a phone; Chrome
 * on Android has no inspector, and remote debugging over a cable is not a reasonable thing to ask.
 * A console line helps whoever has a console. The sentence is what the person holding the phone
 * gets.
 *
 * All four stay calm. Nothing here is an error - a convenience did not land and the passphrase is
 * on the same screen - but calm is not the same as uninformative, which is what one sentence for
 * four causes had been.
 */
export const OPEN_DENIAL_COPY: Record<PrfOpenDenial, string> = {
  // Permanent, and the only one whose remedy is a different action rather than another attempt:
  // the authenticator answered and its output no longer derives the key the wrap was sealed with.
  'different-key': 'lock.passkeyChanged',
  // Permanent too, and it means this device never could.
  'no-prf': 'lock.passkeyNoPrf',
  unanswered: 'lock.passkeyNoAnswer',
  cancelled: 'lock.passkeyMiss',
}
