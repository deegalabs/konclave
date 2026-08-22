/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// Build-time identity for the version badge + update prompt (#pwa). Prefer Vercel's commit env;
// fall back to git; never fail the build if neither is present.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
const commitSha = (() => {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'dev' }
})()

// Relative base so the static build is served correctly by the local bridge
// (`konclave serve`, ADR-0004) and by a future packaged webview.
export default defineConfig({
  plugins: [
    react(),
    // PWA with an explicit UPDATE PROMPT (registerType: 'prompt'), not silent auto-reload: a
    // member mid-ceremony finishes first, then taps "update" (see UpdatePrompt). Precache is a
    // consistent versioned snapshot of the app shell + crypto core (wasm); the LIVE, sensitive
    // surfaces - the /api bridge and the /relay mailbox - are NEVER precached or intercepted, and
    // the share only ever lives in encrypted IndexedDB. Do NOT set skipWaiting/clientsClaim: the
    // useRegisterSW hook owns activation when the user taps update.
    VitePWA({
      registerType: 'prompt',
      // The <UpdatePrompt/> useRegisterSW hook owns registration; don't also auto-inject a script.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Konclave',
        short_name: 'Konclave',
        description: 'O cofre coletivo privado que decide junto. FROST + Zcash, local-first.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#12161a',
        theme_color: '#12161a',
        lang: 'pt-BR',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2,wasm}'],
        // The Orchard/Ironwood WASM core + a couple of large chunks; raise the per-file cap so they
        // are precached (offline + a consistent snapshot).
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
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
