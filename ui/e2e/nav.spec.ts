import { test, expect } from '@playwright/test'

// The vault home identifies the vault, and the left rail navigates - the everyday path. The API is
// stubbed via route interception so the vault identity is deterministic with no backend.

const VAULT = {
  id: 'demo',
  name: 'Common Treasury',
  threshold: 2,
  total: 3,
  members: 3,
  member_list: [
    { name: 'Alice', pubkey: 'a' },
    { name: 'Bob', pubkey: 'b' },
    { name: 'Carol', pubkey: 'c' },
  ],
  group_pubkey: '',
  orchard_address: '',
  locked: false,
}

test.beforeEach(async ({ page }) => {
  // Pin the locale so the rail label selectors are stable (the app can default to pt-BR).
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))

  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  await page.route('**/api/vault**', (r) => r.fulfill({ json: { vault: VAULT } }))
  await page.route('**/api/balance**', (r) =>
    r.fulfill({ json: { configured: true, total_zat: 200_000_000, total_zec: '2.0000', spendable_zec: '2.0000', pending_zec: '0.0000' } }),
  )
  await page.route('**/api/ledger**', (r) => r.fulfill({ json: { proposals: [] } }))
  await page.route('**/api/proposals**', (r) => r.fulfill({ json: { proposals: [] } }))
})

test('vault dashboard shows the vault identity', async ({ page }) => {
  await page.goto('/#/dashboard')
  await expect(
    page.getByRole('heading', { name: /Common Treasury|Tesouraria Comum/i }),
  ).toBeVisible()
})

test('the rail navigates between vault screens', async ({ page }) => {
  await page.goto('/#/dashboard')
  await page.getByRole('link', { name: /^(Ledger|Registro)$/ }).click()
  await expect(page).toHaveURL(/#\/ledger/)
  await page.getByRole('link', { name: /^(Signers|Signatários)$/ }).click()
  await expect(page).toHaveURL(/#\/members/)
})
