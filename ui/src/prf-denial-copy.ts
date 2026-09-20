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
import type { PrfDenial } from './prf-wrap'

export const DENIAL_COPY: Record<PrfDenial, string> = {
  // Permanent: this authenticator does not implement the PRF extension. The copy sends the member
  // to the passphrase rather than inviting a third attempt at something that cannot work.
  'no-prf': 'settings.passkeyNoPrf',
  // The platform never replied. The member did nothing wrong, so "try again" is honest here.
  unanswered: 'settings.passkeyNoAnswer',
  // Including the member pressing Escape, which is a choice, not an error.
  cancelled: 'settings.passkeyCancelled',
}
