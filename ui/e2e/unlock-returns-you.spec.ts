import { test, expect } from '@playwright/test'

// #446 option D. A reload on a protected vault sends you to the unlock screen (#441, correct), and
// unlocking then landed you on `/dashboard` regardless of where you came from. So you lost your
// place as well as your session: you were reading a proposal, you typed your passphrase, and you
// arrived somewhere else.
//
// This persists nothing and changes no threat model. It only stops throwing away the one piece of
// context the app already had.

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

test('the unlock screen remembers where you were sent from', async ({ page }) => {
  await seed(page)
  await page.goto('/#/ledger')
  await expect(page).toHaveURL(/#\/vaults/, { timeout: 10_000 })

  // The destination is carried, so unlocking can return there. Asserted on what the app KEPT
  // rather than on a rendered element: this is about not discarding context, and the passphrase
  // step itself needs a real share, which an e2e cannot produce.
  const from = await page.evaluate(() => history.state?.usr?.from ?? null)
  expect(from, 'the route we were bounced off is remembered').toBe('/ledger')
})

test('landing on the picker directly remembers nothing to return to', async ({ page }) => {
  // The other half. Someone who opens the vault list on purpose has no origin, and inventing one
  // would send them somewhere they never asked for.
  await seed(page)
  await page.goto('/#/vaults')
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => history.state?.usr?.from ?? null)).toBeNull()
})
