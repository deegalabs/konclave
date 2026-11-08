import { test, expect, type Page } from '@playwright/test'

// The dashboard told a member, around a network upgrade, that payments pause around it. NU7 activated
// at block 3,543,405 and payments after it are proven on mainnet, so the notice was removed.
// This drives the real screen with a stubbed balance at tips that used to show it, and checks that
// nothing does now. The window rule (`upgrade-notice.ts`) stays in the code for the next upgrade.

const VAULT_ID = 'a'.repeat(64)
const UPGRADE = 3_543_405

async function openDashboardAt(page: Page, tip: number) {
  const now = { tip }
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
        chain_tip_height: now.tip, orchard_spendable_zat: 0, ironwood_spendable_zat: 0,
      },
    }),
  )
  for (const p of ['**/api/proposals**', '**/api/ledger**', '**/api/members**']) {
    await page.route(p, (r) => r.fulfill({ json: {} }))
  }
  await page.goto('/#/dashboard')
  return (to: number) => {
    now.tip = to
  }
}

test('no tip around the upgrade shows a notice on the dashboard', async ({ page }) => {
  // A positive control first: the dashboard rendered for this vault on the stubbed balance, so the
  // absence below is not a page that never loaded.
  const setTip = await openDashboardAt(page, UPGRADE - 200)
  await expect(page.getByRole('heading', { name: 'V', exact: true })).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(page.getByText(/Zcash network (upgrades|has upgraded)/)).toHaveCount(0)
  setTip(UPGRADE + 500)
  const balance = page.waitForResponse(/\/api\/balance/)
  await page.reload()
  await balance
  await expect(page.getByRole('heading', { name: 'V', exact: true })).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(page.getByText(/Zcash network (upgrades|has upgraded)/)).toHaveCount(0)
})
