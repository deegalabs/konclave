import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { initSync, estimatedFeeZat } from '../src/wasm-pkg/konclave_wasm.js'

// The fee estimate the app adds to an open proposal is the rule's own (konclave_seal, read through
// the wasm with the clock). The spec reads the SAME rule here instead of typing a figure, so the
// expectations follow it when the floor is re-measured or the fee switches.
initSync({ module: readFileSync(fileURLToPath(new URL('../src/wasm-pkg/konclave_wasm_bg.wasm', import.meta.url))) })

// Daniel, 2026-11-07 (#859 review). The Dashboard shows every amount exactly, one precision for one
// figure: the balance, its composition, the desk, the movements and the KPIs. An exact balance can
// carry eight decimals, so the long figure is shrunk to stay inside its card; this drives the real
// screen at desktop width with figures that need every decimal.

const VAULT_ID = 'b'.repeat(64)
const NOW = Math.floor(Date.now() / 1000)

const proposal = (id: string, state: string, zat: number, memo: string) => ({
  id, vault_id: VAULT_ID, kind: 'payment', state, proposer: 'A', value_zat: zat,
  value_zec: (zat / 1e8).toFixed(8), memo, to_address: 'u1dest', is_public: false,
  expiry_unix: NOW + 72 * 3600, created_at: NOW - 3600, approvals: ['A'], refusals: [], approvals_count: 1,
  // The bridge says how many outputs a proposal pays (1 for a payment), which its fee estimate needs.
  destinations: 1,
  ...(state === 'sent' ? { txid: 'cd'.repeat(32) } : {}),
})

async function openDashboard(page: Page) {
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
  await page.route('**/api/balance**', (r) =>
    r.fulfill({
      json: {
        configured: true, total_zat: 1_234_567, total_zec: '0.01234567', spendable_zat: 1_234_567,
        spendable_zec: '0.01234567', chain_tip_height: 3_600_000,
        orchard_spendable_zat: 0, ironwood_spendable_zat: 1_234_567,
      },
    }),
  )
  const open = proposal('p-open', 'awaiting', 12_345, 'Open one')
  const sent = [proposal('p-small', 'sent', 15_000, 'Small one'), proposal('p-big', 'sent', 1_219_567, 'Big one')]
  await page.route('**/api/proposals**', (r) => r.fulfill({ json: { proposals: [open] } }))
  await page.route('**/api/ledger**', (r) => r.fulfill({ json: { ledger: [open, ...sent] } }))
  await page.route('**/api/members**', (r) => r.fulfill({ json: {} }))
  await page.goto('/#/dashboard')
  await expect(page.getByRole('heading', { name: 'V', exact: true })).toBeVisible()
  // Measure the layout a member sees, in the app's own font, not one caught mid-load.
  await page.evaluate(() => document.fonts.ready)
  // A hidden amount is not in the page (#838): the figures below are read and measured revealed.
  await page.locator('.entry .reveal-btn').click()
}

/** The figure stays inside its box: its right edge does not pass the box's. */
async function inside(figure: Locator, box: Locator) {
  const f = await figure.boundingBox()
  const b = await box.boundingBox()
  expect(f && b, 'both boxes are laid out').toBeTruthy()
  expect(f!.x + f!.width).toBeLessThanOrEqual(b!.x + b!.width + 0.5)
}

test('the balance shows every decimal and a long figure stays inside its card', async ({ page }) => {
  await openDashboard(page)
  const amt = page.locator('.entry .fig .amt')
  await expect(amt).toHaveText('0.01234567')
  await expect(amt).toHaveClass(/\bamt-long\b/)
  await inside(amt, page.locator('section.entry').filter({ has: page.locator('.fig .amt') }))
})

test('the composition, the desk, the movements and the KPIs use the same exact figures', async ({ page }) => {
  await openDashboard(page)
  // The open proposal holds its amount plus the estimate of its network fee (#1017), and Free is
  // what that does not hold. The estimate is the rule's, for one destination.
  const fee = estimatedFeeZat(1)
  const exact = (zat: number) => (zat / 1e8).toFixed(8)
  const held = 12_345 + fee
  await expect(page.locator('.comp-legend')).toContainText(exact(1_234_567 - held))
  // The desk still shows the proposal's own amount, not what it holds.
  await expect(page.locator('.ny-amt')).toContainText('0.00012345')
  // The movement of 0.00015 (out, so with its minus sign), not 0.0001.
  await expect(page.getByText(/^−0\.00015$/).first()).toBeAttached()
  const kpis = page.locator('.kpis .kpi')
  await expect(kpis.nth(1).locator('.kpi-v b')).toHaveText(exact(held))
  await expect(kpis.nth(2).locator('.kpi-v b')).toHaveText('0.01234567')
  for (const i of [1, 2]) {
    const kpi = kpis.nth(i)
    await inside(kpi.locator('.kpi-v'), kpi)
    // The long figure is shrunk so its unit stays beside it in the rail's two columns, not wrapped
    // onto a line of its own.
    await expect(kpi.locator('.kpi-v')).toHaveClass(/\bkpi-long\b/)
    const fig = await kpi.locator('.kpi-v b').boundingBox()
    const unit = await kpi.locator('.kpi-u').boundingBox()
    expect(unit!.y, 'the unit is on the figure\'s line').toBeLessThan(fig!.y + fig!.height)
  }
})
