import { test, expect } from '@playwright/test'

// #467, and the retirement of #446 D.
//
// D carried the route you were bounced off so unlocking could return you there. It was the right
// fix for the wrong shape: the bounce itself was the problem. You were reading a proposal, the page
// reloaded, and the vault you were inside vanished into a list you had to pick it out of again -
// which reads as being logged out, not as a locked door.
//
// Now nothing is carried because nothing is lost: the passphrase is asked on the screen you are on.
// Staying put is strictly stronger than being returned, so `returnTo` is gone with the bounce that
// justified it. These drive the real screens, since the whole claim is about routing.

const VAULT_ID = 'a'.repeat(64)

async function seed(page: import('@playwright/test').Page) {
  await page.addInitScript((id) => {
    localStorage.setItem('konclave.selectedVault', id as string)
    const req = indexedDB.open('konclave', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const tx = req.result.transaction('vaults', 'readwrite')
      tx.objectStore('vaults').put({
        id, name: 'Common Treasury', roster: ['Alice', 'Bob'], groupKey: 'ab'.repeat(32),
        address: 'u1demo', createdAt: Date.now(),
        salt: new Uint8Array(16), iv: new Uint8Array(12), cipher: new Uint8Array(8),
        secretIv: new Uint8Array(12), secretCipher: new Uint8Array(8), // sealed S => protected
      })
    }
  }, VAULT_ID)
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  await page.route(/\/api\/vault(\?|$)/, (r) =>
    r.fulfill({ json: { vault: { id: VAULT_ID, name: 'Common Treasury', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: '', orchard_address: 'u1demo' } } }))
  for (const p of ['**/api/vault/balance**', '**/api/vault/proposals**', '**/api/vault/members**', '**/api/vault/ledger**', '**/api/vault/transactions**']) {
    await page.route(p, (r) => r.fulfill({ status: 401, json: { error: 'read key required' } }))
  }
}

test('a reload inside the vault does not move you', async ({ page }) => {
  await seed(page)
  await page.goto('/#/ledger')
  // The overlay first: without it, "still on /ledger" would also be satisfied by an app that simply
  // never noticed the vault was locked - which is the #439 defect, passing itself off as the fix.
  await expect(page.locator('.unlock-overlay input[type="password"]')).toBeVisible({ timeout: 10_000 })
  await expect(page).toHaveURL(/#\/ledger/)
})

test('nothing is carried, because nothing is lost', async ({ page }) => {
  // #446 D's router state is retired. Asserting it is ABSENT keeps the dead mechanism from being
  // quietly resurrected: a `from` that nobody sets and nobody reads is the shape of code that looks
  // live for years.
  await seed(page)
  await page.goto('/#/ledger')
  await expect(page.locator('.unlock-overlay input[type="password"]')).toBeVisible({ timeout: 10_000 })
  expect(await page.evaluate(() => history.state?.usr?.from ?? null)).toBeNull()
})

test('leaving the vault is deliberate', async ({ page }) => {
  // The only exit, and it has to exist: a device that cannot unlock must not be trapped on a screen
  // whose every read is refused. The first button in the pair is "leave"; located structurally
  // because the label is translated and the e2e locale follows the browser.
  await seed(page)
  await page.goto('/#/ledger')
  await expect(page.locator('.unlock-overlay input[type="password"]')).toBeVisible({ timeout: 10_000 })
  await page.locator('.unlock-btns button').first().click()
  await expect(page).toHaveURL(/#\/vaults/, { timeout: 10_000 })
})
