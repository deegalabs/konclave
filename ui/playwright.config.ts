import { defineConfig, devices } from '@playwright/test'

// Frontend e2e against the plain production build served by `vite preview`. Screens render
// with no backend (reads degrade to null), and data-dependent flows stub `/api/*` via
// Playwright route interception — so specs are headless, deterministic, and CI-friendly with
// no build-mode dependency. The app uses HashRouter, so deep links are `/#/dashboard`.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Build the app and serve it statically; specs stub the API they need.
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --host 127.0.0.1 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
})
