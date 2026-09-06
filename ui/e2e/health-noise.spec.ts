import { test, expect } from '@playwright/test'

// #476. The network tab was 26 of 44 requests `health` - three pollers asking the same question:
// the shell every 20s with a bare `setInterval` (so it never paused with the tab), and the
// dashboard every 12s inside its own loader. This counts them, so a third poller cannot be added
// back without something failing.

const VAULT_ID = 'a'.repeat(64)

test('the shell asks about liveness once, and the dashboard does not ask again', async ({ page }) => {
  let healths = 0
  await page.addInitScript((id) => {
    localStorage.setItem('konclave.selectedVault', id as string)
    const req = indexedDB.open('konclave', 1)
    req.onupgradeneeded = () => { const db = req.result
      if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' }) }
    req.onsuccess = () => { const tx = req.result.transaction('vaults', 'readwrite')
      tx.objectStore('vaults').put({ id, name: 'V', roster: ['A'], groupKey: 'ab'.repeat(32),
        address: 'u1demo', createdAt: Date.now(),
        salt: new Uint8Array(16), iv: new Uint8Array(12), cipher: new Uint8Array(8) }) }
  }, VAULT_ID)
  await page.route('**/api/health**', (r) => { healths++; return r.fulfill({ json: { status: 'ok', name: 'k', version: 'e2e' } }) })
  await page.route(/\/api\/vault(\?|$)/, (r) => r.fulfill({ json: { vault: { id: VAULT_ID, name: 'V',
    threshold: 2, total: 3, members: 1, member_list: [{ name: 'A' }], group_pubkey: 'ab'.repeat(32),
    orchard_address: 'u1demo' } } }))
  for (const p of ['**/api/vault/balance**', '**/api/vault/proposals**', '**/api/vault/ledger**', '**/api/vault/members**']) {
    await page.route(p, (r) => r.fulfill({ json: {} }))
  }

  await page.goto('/#/dashboard')
  await page.waitForTimeout(26_000) // past one 20s tick of the shell's poll

  // The shell polls at 20s, so ~26s allows the mount plus one tick. Before this change the
  // dashboard's own 12s loop added two more in the same window.
  expect(healths, `health was requested ${healths} times in 26s`).toBeLessThanOrEqual(3)
})
