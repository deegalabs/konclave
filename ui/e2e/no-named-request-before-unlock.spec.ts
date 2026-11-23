import { test, expect, type BrowserContext, type Page } from '@playwright/test'

// #1108 (T1). A protected vault this device holds a record of, an app opened and NOT unlocked: no
// request, anywhere in the app, names the vault. The capture counts every request, from every page
// and the service worker (the context's, not one page's), whose URL, body or headers carry the vault
// id, over every screen under the shell, past the 12 s poll for 30 s, and a window focus; and every
// websocket the app opens. The record's group key IS the vault id, as in the product, so a request
// carrying either is counted. What the app still sends (health, version.json, the service worker's
// own fetches) names no vault and is not counted.
//
// Three cases: the reopened app; leaving the unlock screen; and switching to the locked vault from
// the rail of another, open, vault.

const VAULT_ID = 'a'.repeat(64)
const OPEN_ID = 'b'.repeat(64)
const ROUTES = ['dashboard', 'pay', 'payroll', 'receive', 'settings', 'members', 'people', 'activity', 'proposals', 'ledger', 'analyses', 'ceremonies']

const short = (u: string) => u.replace(/^(https?|wss?):\/\/[^/]+/, '').slice(0, 24)

/** A web-app browser holding `records` (the first is selected), with every private read gated. */
async function openWith(page: Page, context: BrowserContext, records: { id: string; name: string; protectedVault: boolean }[], watch: string): Promise<string[]> {
  await page.addInitScript(
    ([recs, selected]) => {
      // The web app as it is used: a coordinator is configured, the lock is the device's own.
      localStorage.setItem('konclave.coord.mode', 'custom')
      localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
      localStorage.setItem('konclave.selectedVault', selected as string)
      const req = indexedDB.open('konclave', 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const tx = req.result.transaction('vaults', 'readwrite')
        for (const r of recs as { id: string; name: string; protectedVault: boolean }[]) {
          tx.objectStore('vaults').put({
            id: r.id, name: r.name, roster: ['Alice', 'Bob'], groupKey: r.id,
            address: 'u1demo', createdAt: Date.now(),
            salt: new Uint8Array(16), iv: new Uint8Array(12), cipher: new Uint8Array(8),
            ...(r.protectedVault ? { secretIv: new Uint8Array(12), secretCipher: new Uint8Array(8) } : {}),
          })
        }
      }
    },
    [records, records[0].id] as const,
  )
  const named: string[] = []
  const carries = (s: string) => s.includes(watch)
  // The context sees the pages' requests and the service worker's; a page listener sees only its own.
  context.on('request', (r) => {
    if (carries(r.url() + (r.postData() ?? '') + JSON.stringify(r.headers()))) named.push(`${r.method()} ${short(r.url())}`)
  })
  page.on('websocket', (ws) => {
    if (carries(ws.url())) named.push(`WS ${short(ws.url())}`)
    ws.on('framesent', (f) => { if (carries(String(f.payload))) named.push(`WS frame ${short(ws.url())}`) })
  })
  // Every private read is gated, as in production; registered first so the specific routes win.
  await page.route('**/api/**', (r) => r.fulfill({ status: 401, json: { error: 'read key required' } }))
  // The public vault read answers (it is what the app asks today, to learn the vault's lock).
  await page.route(/\/api\/vault(\?|$)/, (r) => {
    const id = new URL(r.request().url()).searchParams.get('vault') ?? VAULT_ID
    return r.fulfill({ json: { vault: { vault_id: id, id, name: 'Common Treasury', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: id, orchard_address: 'u1demo' } } })
  })
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))

  // The records are written by the init script after the page has started; open the app once on a
  // screen that names no vault, let them land, and reload: the capture is of a REOPENED app.
  await page.goto('/#/intro')
  await page.waitForFunction((n) => new Promise<boolean>((res) => {
    const q = indexedDB.open('konclave', 1)
    q.onsuccess = () => { const g = q.result.transaction('vaults').objectStore('vaults').count(); g.onsuccess = () => res(g.result >= (n as number)) }
    q.onerror = () => res(false)
  }), records.length)
  named.length = 0
  return named
}

test('an opened, not unlocked protected vault is named in no request', async ({ page, context }) => {
  test.setTimeout(120_000)
  const named = await openWith(page, context, [{ id: VAULT_ID, name: 'Common Treasury', protectedVault: true }], VAULT_ID)
  await page.goto('/#/dashboard')
  await page.reload()
  await expect(page.locator('.unlock-overlay input[type="password"]')).toBeVisible({ timeout: 10_000 })
  for (const r of ROUTES) {
    await page.goto(`/#/${r}`)
    await page.waitForTimeout(1000)
  }
  await page.goto('/#/dashboard')
  await page.waitForTimeout(30_000) // past two 12 s polls
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(2000)
  console.log(`named requests: ${named.length}`, named.slice(0, 40))
  expect(named, `requests naming the vault before unlock: ${named.length}`).toEqual([])
})

test('leaving the unlock screen names the vault to nobody', async ({ page, context }) => {
  test.setTimeout(60_000)
  const named = await openWith(page, context, [{ id: VAULT_ID, name: 'Common Treasury', protectedVault: true }], VAULT_ID)
  await page.goto('/#/dashboard')
  await page.reload()
  await expect(page.locator('.unlock-overlay input[type="password"]')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Leave the vault' }).click()
  await expect(page).toHaveURL(/#\/vaults/)
  await page.waitForTimeout(3000)
  expect(named, `requests naming the vault after leaving: ${named.length}`).toEqual([])
})

test('switching from the rail to a locked vault names it to nobody', async ({ page, context }) => {
  test.setTimeout(60_000)
  // The open vault is the one the app is in; the locked one is what the capture watches.
  const named = await openWith(page, context, [
    { id: OPEN_ID, name: 'Open Fund', protectedVault: false },
    { id: VAULT_ID, name: 'Common Treasury', protectedVault: true },
  ], VAULT_ID)
  await page.goto('/#/dashboard')
  await page.reload()
  await expect(page.locator('.rail-vault-chip')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(2000)
  await page.locator('.rail-vault-chip').click()
  await page.locator('.vault-pop-row', { hasText: 'Common Treasury' }).click()
  await page.waitForTimeout(4000)
  expect(named, `requests naming the locked vault after a switch: ${named.length}`).toEqual([])
})
