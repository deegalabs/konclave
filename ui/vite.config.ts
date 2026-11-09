/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { RELEASE_SOURCES, releasePagesOrFail, tagsForPages } from '../scripts/changelog-sections.mjs'

// Build-time identity for the version badge + update prompt (#pwa). Prefer Vercel's commit env;
// fall back to git; never fail the build if neither is present.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
const commitSha = (() => {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'dev' }
})()

// The desktop build (desktop-release.yml sets KONCLAVE_DESKTOP_BUILD=1) ships a SELF-DESTROYING
// service worker in place of the web's: an `sw.js` that unregisters itself and empties the caches.
// The desktop app has no use for a worker, and the one an earlier version left in the WebView
// profile opened the window blank after an upgrade (desktop-worker.ts). The browser fetches `sw.js`
// by itself while checking the old worker for an update, so this reaches a profile even when the
// page the old worker serves never runs. Unset or empty is the web build, exactly '1' is the desktop
// build, and anything else stops the build: a typo ('true', 'yes') must not ship an installer with
// the web's worker in it. Both workflows then check which `sw.js` came out.
const desktopFlag = process.env.KONCLAVE_DESKTOP_BUILD ?? ''
if (desktopFlag !== '' && desktopFlag !== '1') {
  throw new Error(`KONCLAVE_DESKTOP_BUILD must be unset or exactly '1', got '${desktopFlag}'`)
}
const desktopBuild = desktopFlag === '1'

// Relative base so the static build is served correctly by the local bridge
// (`konclave serve`, ADR-0004) and by a future packaged webview.
export default defineConfig({
  plugins: [
    // One docs page per released version, built from the changelogs with the function that writes
    // the GitHub release body, so a release is never written twice. Only the converted pages reach
    // the bundle, in their own chunk (Docs imports this module when a release page is opened).
    // A shallow clone has no tags, so their names are listed from the remote; zero pages stops the build.
    {
      name: 'konclave-release-pages',
      resolveId: (id) => (id === 'virtual:konclave-releases' ? '\0virtual:konclave-releases' : undefined),
      load(id) {
        if (id !== '\0virtual:konclave-releases') return
        const mds = (RELEASE_SOURCES as [string, string][]).map(([file]) => {
          const path = fileURLToPath(new URL(`../${file}`, import.meta.url))
          this.addWatchFile(path)
          return readFileSync(path, 'utf8')
        })
        return `export default ${JSON.stringify(releasePagesOrFail(mds, tagsForPages()))}`
      },
    },
    // The waiting build names itself to the running one: the update banner reads this file (not
    // precached: workbox only takes js, css, html, images, fonts and wasm) to say which version is
    // arriving, not only which one is running.
    {
      name: 'konclave-version-file',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: pkg.version, commit: commitSha }) })
      },
    },
    react(),
    // PWA with an explicit UPDATE PROMPT (registerType: 'prompt'), not silent auto-reload: a
    // member mid-ceremony finishes first, then taps "update" (see UpdatePrompt). Precache is a
    // consistent versioned snapshot of the app shell + crypto core (wasm); the LIVE, sensitive
    // surfaces - the /api bridge and the /relay mailbox - are NEVER precached or intercepted, and
    // the share only ever lives in encrypted IndexedDB. Do NOT set skipWaiting/clientsClaim: the
    // useRegisterSW hook owns activation when the user taps update.
    VitePWA({
      registerType: 'prompt',
      // Desktop only: see `desktopBuild` above. The web keeps its worker.
      selfDestroying: desktopBuild,
      // The <UpdatePrompt/> useRegisterSW hook owns registration; don't also auto-inject a script.
      injectRegister: false,
      // The `mark-*` set is drawn from the same geometry as the live <Mark/> emblem
      // (ui/src/components.tsx). The older `icon-*`/`favicon.svg` files are kept on disk on
      // purpose - nothing that shipped is deleted - they are simply no longer the ones referenced.
      includeAssets: ['mark-favicon.svg', 'mark-apple-touch.png'],
      manifest: {
        name: 'Konclave',
        short_name: 'Konclave',
        description: 'O cofre coletivo privado que decide junto. FROST + Zcash, local-first.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0f141a',
        theme_color: '#0f141a',
        lang: 'pt-BR',
        icons: [
          { src: 'mark-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'mark-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'mark-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2,wasm}'],
        // The release pages (konclave-release-pages) are every release's notes and grow with each one;
        // they load when a release page is opened, so they are not precached.
        globIgnores: ['**/*konclave-releases*'],
        // The Orchard/Ironwood WASM core + a couple of large chunks; raise the per-file cap so they
        // are precached (offline + a consistent snapshot).
        // Headroom over the wasm, which is the only file near this ceiling. Workbox drops an
        // oversized file from the precache SILENTLY - no error, no warning - so the app would keep
        // building and start failing offline for exactly the file it cannot work without. Raised
        // from 4 MB because adding the Orchard prover measures at 2.34 MB (#516), which leaves too
        // little room to notice the cliff before falling off it.
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
        // Never serve the SPA shell (or cache) the live bridge / mailbox.
        navigateFallbackDenylist: [/^\/api\//, /^\/relay\//],
      },
    }),
  ],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_SHA__: JSON.stringify(commitSha),
  },
  build: { outDir: 'dist' },
  // In `npm run dev` (and `tauri dev`), proxy the API to the local bridge so the UI works against
  // the real backend when it is running. The bridge is OPTIONAL in dev: without it the app falls
  // back to demo/mock, so a connection refused is expected, not an error. Quiet the noisy
  // ECONNREFUSED stack to a single line and answer 503 so the request never hangs. In production
  // the bundle is served by the bridge itself (same origin), so `/api/*` is already relative.
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4762',
        changeOrigin: true,
        configure: (proxy) => {
          let warned = false
          proxy.on('error', (err, _req, res) => {
            if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
              if (!warned) {
                console.log('[dev] local bridge (konclave serve) not running - the app uses demo/mock data')
                warned = true
              }
              const r = res as { writableEnded?: boolean; headersSent?: boolean; writeHead?: (n: number) => void; end?: (s?: string) => void }
              if (r && typeof r.writeHead === 'function' && !r.headersSent && !r.writableEnded) {
                r.writeHead(503)
                r.end?.('local bridge not running')
              }
            }
          })
        },
      },
    },
  },
  // Vitest owns the unit tests under src/. The Playwright e2e specs live in e2e/ and are
  // run by `npm run e2e` - exclude them here so vitest does not try to load @playwright/test.
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
