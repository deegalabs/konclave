import { test, expect } from '@playwright/test'

// The single most valuable trust spec (CLAUDE §7 "preview + explicit confirmation"): before real
// ZEC moves, the send-confirm dialog must RESTATE what is being sent — the amount and recipient.
// The API is stubbed via route interception, so this drives a READY proposal end to end with no
// backend and no build-mode dependency.

const RECIPIENT =
  'u1exampledeadbeefcafe000000000000000000000000000000000000000000000000000000000000000000000000d406dr'

const READY_PROPOSAL = {
  id: 'prop-102',
  vault_id: 'demo',
  kind: 'payment',
  state: 'ready',
  proposer: 'Alice',
  value_zat: 12_000_000,
  value_zec: '0.1200',
  to_address: RECIPIENT,
  is_public: false,
  expiry_unix: Math.floor(Date.now() / 1000) + 3600,
  created_at: Math.floor(Date.now() / 1000),
  approvals: ['Alice', 'Bob'],
  refusals: [],
  approvals_count: 2,
}

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
  orchard_address: RECIPIENT,
  locked: false,
}

test.beforeEach(async ({ page }) => {
  // Pin the locale so the button/label selectors are stable (the app defaults to pt-BR).
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))

  // Patterns end in `**` so they match with or without the `?vault=` query the client
  // appends. Playwright gives precedence to the LAST registered matching route, so the
  // broad `/api/proposals**` is registered before the specific `/api/proposals/prop-102`.
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  await page.route('**/api/vault**', (r) => r.fulfill({ json: { vault: VAULT } }))
  await page.route('**/api/balance**', (r) =>
    r.fulfill({ json: { configured: true, total_zat: 200_000_000, total_zec: '2.0000', spendable_zec: '2.0000', pending_zec: '0.0000' } }),
  )
  await page.route('**/api/ledger**', (r) => r.fulfill({ json: { proposals: [] } }))
  await page.route('**/api/proposals**', (r) => r.fulfill({ json: { proposals: [READY_PROPOSAL] } }))
  await page.route('**/api/proposals/prop-102**', (r) => r.fulfill({ json: { proposal: READY_PROPOSAL, lines: [] } }))
})

test('the send confirmation restates the amount and recipient before broadcasting', async ({ page }) => {
  await page.goto('/#/proposals')

  // Open the ready-to-sign proposal (0.1200 ZEC).
  await page.locator('.plist-row').filter({ hasText: '0.1200' }).first().click()
  await expect(page).toHaveURL(/#\/proposal/)

  // Trigger the money-moving action.
  await page.getByRole('button', { name: /sign and send/i }).click()

  // The confirmation restates the amount AND recipient — not a generic warning.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.send-confirm-what')).toBeVisible()
  await expect(dialog).toContainText('0.1200')
  await expect(dialog).toContainText('ZEC')
})
