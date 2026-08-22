/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the static build is served correctly by the local bridge
// (`konclave serve`, ADR-0004) and by a future packaged webview.
export default defineConfig({
  plugins: [react()],
  base: './',
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
