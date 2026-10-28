import { test, expect, type Page } from '@playwright/test'

// The dashboard tells a member, before they try to pay, that the network is about to upgrade and that
// payments pause around it. It reads the chain tip from the balance answer and the upgrade height from
// WASM (the epoch table); this drives the real screen with a stubbed balance at three tips.

const VAULT_ID = 'a'.repeat(64)
const UPGRADE = 3_543_405

async function openDashboardAt(page: Page, tip: number) {
  await page.addInitScript((id) => {
    localStorage.setItem('konclave.locale', 'en')
    localStorage.setItem('konclave.selectedVault', id as string)
    const req = indexedDB.open('konclave', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const tx = req.result.transaction('vaults', 'readwrite')
      tx.objectStore('vaults').put({
        id, name: 'V', roster: ['A'], groupKey: 'ab'.repeat(32), address: 'u1demo', createdAt: Date.now(),
        salt: new Uint8Array(16), iv: new Uint8Array(12), cipher: new Uint8Array(8),
      })
    }
  }, VAULT_ID)
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'k', version: 'e2e' } }))
  await page.route(/\/api\/vault(\?|$)/, (r) =>
    r.fulfill({
      json: {
        vault: {
          id: VAULT_ID, name: 'V', threshold: 2, total: 3, members: 1, member_list: [{ name: 'A' }],
          group_pubkey: 'ab'.repeat(32), orchard_address: 'u1demo',
        },
      },
    }),
  )
  // The plain build reads through the local bridge, whose balance answer is what the dashboard maps.
  await page.route('**/api/balance**', (r) =>
    r.fulfill({
      json: {
        configured: true, total_zat: 0, total_zec: '0', spendable_zat: 0, spendable_zec: '0',
        chain_tip_height: tip, orchard_spendable_zat: 0, ironwood_spendable_zat: 0,
      },
    }),
  )
  for (const p of ['**/api/proposals**', '**/api/ledger**', '**/api/members**']) {
    await page.route(p, (r) => r.fulfill({ json: {} }))
  }
  await page.goto('/#/dashboard')
}

test('a tip just before the upgrade shows the notice with the block, from the table', async ({ page }) => {
  await openDashboardAt(page, UPGRADE - 200)
  await expect(page.getByRole('status').filter({ hasText: /upgrades at block 3,543,405/ })).toBeVisible()
  await expect(page.getByText(/Nothing is lost and your approvals stand/)).toBeVisible()
})

test('a tip just after it says what to expect, without promising a time', async ({ page }) => {
  await openDashboardAt(page, UPGRADE + 500)
  await expect(page.getByRole('status').filter({ hasText: /The Zcash network has upgraded/ })).toBeVisible()
})

test('a tip far from it shows no notice', async ({ page }) => {
  await openDashboardAt(page, UPGRADE - 20_000)
  await page.waitForTimeout(1_500)
  await expect(page.getByText(/Zcash network (upgrades|has upgraded)/)).toHaveCount(0)
})
