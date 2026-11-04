import { test, expect, type Page } from '@playwright/test'

// #811: the Ledger's "PDF" button prints the page, and the printed page was the screen as laid out.
// On a phone that is the stacked-card layout with the menu and the filter chips. The print layout
// is a document: the same rows and totals as the screen, a full-width table, the active filter as
// text, no controls, rows never split across a page, and the same at desktop and at phone width.

const ADDR = 'u1exampledeadbeefcafe000000000000000000000000000000000000000000000000000000000000000000000000d406dr'
const now = Math.floor(Date.now() / 1000)
const P = (id: string, state: string, zat: number, memo: string) => ({
  id, vault_id: 'demo', kind: 'payment', state, proposer: 'Alice', value_zat: zat, value_zec: (zat / 1e8).toFixed(8),
  to_address: ADDR, is_public: false, expiry_unix: now + 3600, created_at: now - 60, approvals: ['Alice', 'Bob'],
  refusals: [], approvals_count: 2, memo,
})
const BOOK = [P('p1', 'confirmed', 10_000_000, 'Rent'), P('p2', 'sent', 20_000_000, 'Hosting'), P('p3', 'awaiting', 5_000_000, 'Design')]
const VAULT = {
  id: 'demo', name: 'Common Treasury', threshold: 2, total: 3, members: 3,
  member_list: [{ name: 'Alice', pubkey: 'a' }, { name: 'Bob', pubkey: 'b' }, { name: 'Carol', pubkey: 'c' }],
  group_pubkey: '', orchard_address: ADDR, locked: false,
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  await page.route('**/api/vault**', (r) => r.fulfill({ json: { vault: VAULT } }))
  await page.route('**/api/balance**', (r) => r.fulfill({ json: { configured: true, total_zat: 100_000_000, total_zec: '1.0000', spendable_zec: '1.0000', pending_zec: '0.0000' } }))
  await page.route('**/api/ledger**', (r) => r.fulfill({ json: { ledger: BOOK } }))
  await page.route('**/api/proposals**', (r) => r.fulfill({ json: { proposals: BOOK } }))
})

async function printed(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await page.goto('/#/ledger')
  await expect(page.locator('table.razao tbody tr')).toHaveCount(3)
  await page.emulateMedia({ media: 'print' })
  return page
}

for (const [label, w, h] of [['desktop', 1280, 900], ['phone', 390, 844]] as const) {
  test(`printed at ${label} width: a document with the rows, the totals and no controls`, async ({ page }) => {
    await printed(page, w, h)

    // No navigation, no buttons, no filter chips.
    await expect(page.locator('.rail')).toBeHidden()
    await expect(page.locator('.page-header-actions')).toBeHidden()
    await expect(page.locator('.filters')).toBeHidden()
    await expect(page.getByRole('button', { name: /PDF/ })).toBeHidden()

    // A table at every width: the header shows, and each row is a table row, never a card.
    const head = page.locator('table.razao thead th')
    await expect(head).toHaveText(['Date', 'Document', 'Who proposed / approved', 'Value'])
    const rows = page.locator('table.razao tbody tr')
    await expect(rows).toHaveCount(3)
    for (const i of [0, 1, 2]) {
      expect(await rows.nth(i).evaluate((el) => getComputedStyle(el).display)).toBe('table-row')
      expect(await rows.nth(i).evaluate((el) => getComputedStyle(el).breakInside)).toBe('avoid')
    }
    expect(await page.locator('table.razao thead').evaluate((el) => getComputedStyle(el).display)).toBe('table-header-group')

    // The totals are the screen's: settled 0.1 + 0.2, open 0.05.
    await expect(page.locator('.doc-band')).toContainText('0.3000')
    await expect(page.locator('.doc-band')).toContainText('0.0500')

    // The active filter is written out, since the chips are not printed.
    await expect(page.locator('.ledger-print-filter')).toBeVisible()
    await expect(page.locator('.ledger-print-filter')).toContainText('Filter: All')
  })
}

test('a filter applied on screen is written on the printed page, with the rows it keeps', async ({ page }) => {
  await page.goto('/#/ledger')
  await expect(page.locator('table.razao tbody tr')).toHaveCount(3)
  await page.locator('.filters').getByRole('button', { name: 'Settled', exact: true }).click()
  await expect(page.locator('table.razao tbody tr')).toHaveCount(2)
  await page.emulateMedia({ media: 'print' })
  await expect(page.locator('table.razao tbody tr')).toHaveCount(2)
  await expect(page.locator('.ledger-print-filter')).toContainText('Filter: Settled')
})

test('hidden amounts stay hidden on paper, and the page says how to print them', async ({ page }) => {
  await printed(page, 1280, 900)
  // Browsers drop backgrounds when printing, which would print the amount under its bar.
  const bar = page.locator('.doc-band .secret .bar').first()
  expect(await bar.evaluate((el) => getComputedStyle(el).printColorAdjust)).toBe('exact')
  await expect(page.locator('.ledger-print-hidden')).toBeVisible()
})
