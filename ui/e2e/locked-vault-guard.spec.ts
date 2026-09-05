import { test, expect } from '@playwright/test'

// #439, through the real screens. A #388-protected vault could be entered while locked: the guard
// asked the BRIDGE's `locked` flag, which a browser-native vault never sets, so it never fired.
// Every private read then came back 401 and the dashboard rendered as if the vault were empty.
//
// A page reload is enough to produce it, because the unlocked share lives in memory. That is what
// these drive: seed a record, land on the dashboard, and assert the app does not stay there.

const VAULT_ID = 'a'.repeat(64)

/** Seed a local vault record. `secured` is `!!secretCipher`, so the sealed S is what makes it protected. */
async function seed(page: import('@playwright/test').Page, opts: { secured: boolean }) {
  await page.addInitScript(
    ([id, secured]) => {
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
          // The sealed access secret S is what `listVaults` reports as `secured`.
          ...(secured ? { secretIv: new Uint8Array(12), secretCipher: new Uint8Array(8) } : {}),
        })
      }
    },
    [VAULT_ID, opts.secured] as const,
  )
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  // The helper answers the PUBLIC vault read; a browser-native vault carries no `locked` flag,
  // which is exactly why the old guard never fired.
  await page.route(/\/api\/vault(\?|$)/, (r) =>
    r.fulfill({ json: { vault: { id: VAULT_ID, name: 'Common Treasury', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: '', orchard_address: 'u1demo' } } }))
  // Every PRIVATE read is gated, which is what the member actually hit in production.
  for (const p of ['**/api/vault/balance**', '**/api/vault/proposals**', '**/api/vault/members**', '**/api/vault/ledger**', '**/api/vault/transactions**']) {
    await page.route(p, (r) => r.fulfill({ status: 401, json: { error: 'read key required' } }))
  }
}

test('a protected vault with no unlocked share does not open its dashboard', async ({ page }) => {
  // The regression. Before the fix the app sat here on a blank dashboard while the console filled
  // with 401s, and the only way out was guessing that the passphrase was the answer.
  await seed(page, { secured: true })
  await page.goto('/#/dashboard')
  await expect(page).toHaveURL(/#\/vaults/, { timeout: 10_000 })
})

test('an OPEN vault still opens: its reads never needed a token', async ({ page }) => {
  // The half that must not break. The helper keeps the gate open until a readKey is registered, so
  // demanding an unlock here would lock people out of the vaults that have not migrated to #388.
  await seed(page, { secured: false })
  await page.goto('/#/dashboard')
  await page.waitForTimeout(1500)
  // Asserting the URL it IS on, not merely the one it is not: "never navigated at all" would
  // satisfy a not-/vaults check just as well as "correctly stayed".
  await expect(page).toHaveURL(/#\/dashboard/)
})
