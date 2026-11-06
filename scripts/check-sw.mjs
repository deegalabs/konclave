// Which service worker a UI build produced, checked after the build rather than trusted from the flag.
//
// The desktop installers must ship vite-plugin-pwa's SELF-DESTROYING worker: an `sw.js` that
// unregisters itself and empties the caches. The worker v0.15.0 left in the WebView profile opened
// v0.16.0 to a blank window on Windows, and the desktop app has no use for one. The web must ship the
// workbox worker that precaches the app, or it stops opening offline. One environment variable
// (KONCLAVE_DESKTOP_BUILD, read in ui/vite.config.ts) decides which, so each workflow checks the
// output it is about to ship: desktop-release.yml for the desktop, ci.yml for the web.
//
// Usage: node scripts/check-sw-cli.mjs <desktop|web> <path/to/sw.js>
//
// The rule lives here, with tests (ui/src/check-sw.test.ts), and not as shell in the workflows: a
// check nobody can run before merging is a check nobody has checked.
/** The call only the self-destroying worker makes. */
const UNREGISTER = /self\.registration\.unregister\(\)/
/** The call only the workbox worker makes: it is what puts the app in the cache. */
const PRECACHE = /\bprecacheAndRoute\b/

/**
 * What `sw.js` is: 'desktop' (self-destroying), 'web' (workbox precache), or 'unknown' for anything
 * else, including a file that has both calls or neither.
 */
export function swKind(src) {
  const unregisters = UNREGISTER.test(src)
  const precaches = PRECACHE.test(src)
  if (unregisters && !precaches) return 'desktop'
  if (precaches && !unregisters) return 'web'
  return 'unknown'
}

/** null when `src` is the worker `expected` must ship, otherwise the reason it is not. */
export function checkSw(expected, src) {
  if (expected !== 'desktop' && expected !== 'web') return `expected must be 'desktop' or 'web', got '${expected}'`
  const kind = swKind(src)
  if (kind === expected) return null
  const want = expected === 'desktop'
    ? 'the self-destroying worker (self.registration.unregister(), no precacheAndRoute)'
    : 'the workbox worker (precacheAndRoute, no self.registration.unregister())'
  return `sw.js is not ${want}; it reads as '${kind}'.`
    + (expected === 'desktop' ? ' Was the UI built with KONCLAVE_DESKTOP_BUILD=1?' : ' Was KONCLAVE_DESKTOP_BUILD set for a web build?')
}
