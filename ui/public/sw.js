// Konclave PWA service worker - minimal and update-safe.
//
// Network-first by design: an ONLINE device always fetches fresh JS/WASM, so it never runs
// a stale cryptographic core; the cache is only an OFFLINE fallback for the app shell. The
// /api bridge and the /relay mailbox are LIVE and sensitive and are never cached. The share
// itself never touches this cache - it lives only in encrypted IndexedDB.

const CACHE = 'konclave-shell-v1'
const SHELL = ['./', './index.html', './favicon.svg', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Live, sensitive, or non-GET: always hit the network, never cache.
  if (req.method !== 'GET' || url.pathname.includes('/api/') || url.pathname.includes('/relay/')) {
    return
  }

  // Network-first: fresh when online; cached app shell when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(req, copy))
        }
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  )
})
