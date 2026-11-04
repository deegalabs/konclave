// The desktop app has no use for the web's service worker, and an old one broke it.
//
// The web registers a worker (vite-plugin-pwa, <UpdatePrompt />) so the app opens offline and a new
// deploy waits for the member's tap. Inside the desktop shell the app is already on the disk, and a
// new version arrives with the installer, not from a server. A worker there only gets between the
// two: on Windows, the v0.16.0 installer replaced v0.15.0 while the WebView profile kept the worker
// v0.15.0 had registered, and the window opened blank until that profile was moved aside.
//
// Two parts retire it:
//   - the desktop build ships a self-destroying `sw.js` (vite.config.ts, flag set in
//     desktop-release.yml). The browser fetches it on its own while checking the old worker for an
//     update, so it works even when the page the old worker serves never runs our code;
//   - this file, which runs at startup on desktop and removes any worker and any worker cache left,
//     for when the page does run.
//
// Only the service worker registrations and the workbox caches in CacheStorage are touched. The
// encrypted share, the read secret and every other record live in IndexedDB and localStorage, and
// nothing here reads or writes either.

/** The caches vite-plugin-pwa's workbox creates (`workbox-precache-v2-...` and its runtime ones). */
export const WORKBOX_CACHE = /^workbox-/

type Registrations = { getRegistrations(): Promise<ReadonlyArray<{ unregister(): Promise<boolean> }>> }
type Caches = { keys(): Promise<string[]>; delete(name: string): Promise<boolean> }

export type RetireResult = { unregistered: number; cachesDeleted: string[] }

/**
 * Unregister every service worker on this origin and delete the workbox caches. Never throws: a
 * webview without service workers or CacheStorage has nothing to retire, and a failure here must not
 * stop the app from opening. Errors go to the local console only.
 */
export async function retireServiceWorkers(
  sw: Registrations | undefined = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
  cacheStorage: Caches | undefined = typeof caches !== 'undefined' ? caches : undefined,
): Promise<RetireResult> {
  const out: RetireResult = { unregistered: 0, cachesDeleted: [] }
  try {
    if (sw) {
      for (const r of await sw.getRegistrations()) {
        if (await r.unregister()) out.unregistered++
      }
    }
  } catch (e) {
    console.error('Konclave could not remove an old service worker:', e)
  }
  try {
    if (cacheStorage) {
      for (const name of await cacheStorage.keys()) {
        if (WORKBOX_CACHE.test(name) && (await cacheStorage.delete(name))) out.cachesDeleted.push(name)
      }
    }
  } catch (e) {
    console.error('Konclave could not remove an old service worker cache:', e)
  }
  return out
}
