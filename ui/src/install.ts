// Offering to install the PWA.
//
// The app is installable - manifest, icons and an active service worker are all in place - but a
// browser will not offer it on its own any more. Chromium removed the automatic banner: it fires
// `beforeinstallprompt`, and unless the page keeps that event and calls `prompt()` from a real user
// gesture, the capability stays buried in the browser menu. Safari on iOS never fires it at all;
// there the only route is Share -> Add to Home Screen, which the app has to TEACH, not prompt.
//
// So there are three answers, not two, and the decision is a pure function of three observations.

/** The `beforeinstallprompt` event, which is not in the DOM lib because it is not standardised. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallOffer =
  /** Running as an installed app already - offer nothing. */
  | { kind: 'installed' }
  /** The browser handed us a prompt we can fire from a tap. */
  | { kind: 'prompt' }
  /** iOS: no event exists, so show the Share -> Add to Home Screen instruction. */
  | { kind: 'ios' }
  /** Nothing to offer: a browser that does not support it, or the event has not arrived yet. */
  | { kind: 'none' }

/** Pure decision. `standalone` wins over everything: an installed app must never be told to
 *  install itself, and on iOS that is the only signal we get. */
export function installOffer(o: {
  standalone: boolean
  deferred: boolean
  ios: boolean
}): InstallOffer {
  if (o.standalone) return { kind: 'installed' }
  if (o.deferred) return { kind: 'prompt' }
  if (o.ios) return { kind: 'ios' }
  return { kind: 'none' }
}

/** True when the page is running as an installed app. Two signals because the platforms disagree:
 *  `display-mode: standalone` is the standard one, and `navigator.standalone` is Safari's. */
export function isStandalone(win: {
  matchMedia?: (q: string) => { matches: boolean }
  navigator?: { standalone?: boolean }
}): boolean {
  try {
    if (win.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch { /* matchMedia unavailable (older engines, tests) */ }
  return win.navigator?.standalone === true
}

/** True on iOS, where every browser is WebKit and Add to Home Screen is the only install route.
 *  iPadOS 13+ reports itself as a Mac, so a Mac with a touch screen is treated as an iPad - the
 *  cost of being wrong is showing a Share hint on a desktop Safari, not a broken install. */
export function isIos(nav: { userAgent?: string; platform?: string; maxTouchPoints?: number }): boolean {
  const ua = nav.userAgent ?? ''
  if (/iPhone|iPod/.test(ua)) return true
  if (/iPad/.test(ua)) return true
  return /Mac/.test(nav.platform ?? '') && (nav.maxTouchPoints ?? 0) > 1
}
