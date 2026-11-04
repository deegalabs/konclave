import { test, expect, type Page } from '@playwright/test'

// The desktop app (Tauri) opened to a blank window after the v0.16.0 installer replaced v0.15.0: the
// WebView profile kept the service worker v0.15.0 had registered, and moving the profile aside fixed
// it. The desktop app now registers no worker and removes one it finds. Tauri 2 always injects
// `__TAURI_INTERNALS__` before the page's scripts; stubbing it here is how the app knows it is inside
// the shell (platform.ts). This runs the web build, so it checks the runtime half of the fix; the
// self-destroying `sw.js` of the desktop build is pinned in desktop-worker.test.ts.

const TAURI = () => { (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {} }

const workers = (page: Page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)
const controlled = (page: Page) => page.evaluate(() => navigator.serviceWorker.controller !== null)
const workboxCaches = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('workbox-')).length)
// A vault record in the app's own IndexedDB store (where the sealed share lives) and a localStorage key
// (where the selected vault and the settings live). The fix may touch workers and CacheStorage only.
const VAULT_ID = 'c'.repeat(64)
const seedRecords = (page: Page) => page.evaluate((id) => new Promise<void>((ok, fail) => {
  localStorage.setItem('konclave.e2e-probe', 'kept')
  const req = indexedDB.open('konclave', 1)
  req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('vaults')) req.result.createObjectStore('vaults', { keyPath: 'id' }) }
  req.onerror = () => fail(req.error)
  req.onsuccess = () => {
    const tx = req.result.transaction('vaults', 'readwrite')
    tx.objectStore('vaults').put({ id, name: 'Probe vault', roster: ['A'], groupKey: 'ab'.repeat(32), address: 'u1demo',
      createdAt: Date.now(), salt: new Uint8Array(16), iv: new Uint8Array(12), cipher: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) })
    tx.oncomplete = () => { req.result.close(); ok() }
    tx.onerror = () => fail(tx.error)
  }
}), VAULT_ID)
const readRecords = (page: Page) => page.evaluate((id) => new Promise<{ local: string | null; vault: { name: string; cipher: number[] } | null }>((ok, fail) => {
  const local = localStorage.getItem('konclave.e2e-probe')
  const req = indexedDB.open('konclave', 1)
  req.onerror = () => fail(req.error)
  req.onsuccess = () => {
    const get = req.result.transaction('vaults').objectStore('vaults').get(id)
    get.onsuccess = () => {
      const v = get.result as { name: string; cipher: Uint8Array } | undefined
      req.result.close()
      ok({ local, vault: v ? { name: v.name, cipher: [...v.cipher] } : null })
    }
    get.onerror = () => fail(get.error)
  }
}), VAULT_ID)
const rendered = (page: Page) => page.evaluate(() => document.getElementById('root')?.childElementCount ?? 0)

test('on the web the worker still registers (so the desktop checks below are not vacuous)', async ({ page }) => {
  await page.goto('/')
  await expect.poll(() => workers(page), { timeout: 15_000 }).toBe(1)
})

test('inside the desktop shell: no worker after a load and a reload, and the app renders', async ({ page }) => {
  await page.addInitScript(TAURI)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  // The web registers within this window (the test above); give the desktop the same chance to.
  await page.waitForTimeout(3_000)
  expect(await workers(page)).toBe(0)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.waitForTimeout(3_000)
  expect(await workers(page)).toBe(0)
  expect(await controlled(page)).toBe(false)
  expect(await rendered(page)).toBeGreaterThan(0)
})

test('a worker an earlier version left in the profile is removed, with its caches', async ({ context }) => {
  // An earlier version, as the web registers it: the worker installs and takes the page over.
  const before = await context.newPage()
  await before.goto('/')
  await expect.poll(() => workers(before), { timeout: 15_000 }).toBe(1)
  // Installed and active (the precache is several MB), so the next load is the worker's.
  await before.evaluate(async () => { await navigator.serviceWorker.ready })
  await before.reload()
  await expect.poll(() => controlled(before), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => workboxCaches(before), { timeout: 15_000 }).toBeGreaterThan(0)
  await seedRecords(before)
  await before.close()

  // The same profile opened by the desktop app.
  const page = await context.newPage()
  await page.addInitScript(TAURI)
  await page.goto('/')
  await expect.poll(() => workers(page), { timeout: 15_000 }).toBe(0)
  await expect.poll(() => workboxCaches(page), { timeout: 15_000 }).toBe(0)
  // Unregistering lets go of the page on its next load: from then on nothing stands between them.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await controlled(page)).toBe(false)
  expect(await workers(page)).toBe(0)
  expect(await rendered(page)).toBeGreaterThan(0)
  // What the member keeps on this device is still there, byte for byte, and the app reads it.
  expect(await readRecords(page)).toEqual({ local: 'kept', vault: { name: 'Probe vault', cipher: [1, 2, 3, 4, 5, 6, 7, 8] } })
  await expect(page.getByText('Probe vault')).toBeVisible()
})
