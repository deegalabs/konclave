import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the static build is served correctly by the local bridge
// (`konclave serve`, ADR-0004) and by a future packaged webview.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  // In `npm run dev`, proxy the API to the local bridge so the UI works against the
  // real backend. In production the bundle is served by the bridge itself (same origin),
  // so `/api/*` is already relative.
  server: {
    proxy: {
      '/api': 'http://localhost:4762',
    },
  },
})
