import { test, expect } from '@playwright/test'

import { en } from '../src/i18n/en'

// #929, in a real browser. jsdom does not do implicit form submission, so Enter is only provable
// here. The passphrase fields sit in a form now (so a password manager can pair the hidden
// username with them); the rule is that the form changes nothing about what Enter does: where
// Enter did nothing before (the export and the rotation dialogs), it still does nothing, the page
// does not reload, and the dialog stays.

const ID = 'c'.repeat(64)

async function seed(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ([id]) => {
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
          id, name: 'Common Treasury', roster: ['Alice', 'Bob'], groupKey: 'ab'.repeat(32),
          address: 'u1demo', createdAt: Date.now(),
        })
      }
    },
    [ID] as const,
  )
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  await page.route(/\/api\/vault(\?|$)/, (r) =>
    r.fulfill({ json: { vault: { id: ID, name: 'Common Treasury', threshold: 2, total: 2, members: 2, member_list: [], group_pubkey: '', orchard_address: 'u1demo' } } }))
  for (const p of ['**/api/vault/balance**', '**/api/vault/proposals**', '**/api/vault/members**', '**/api/vault/ledger**', '**/api/vault/transactions**']) {
    await page.route(p, (r) => r.fulfill({ status: 401, json: { error: 'read key required' } }))
  }
}

test('Enter in the export passphrase does nothing: no reload, the dialog stays', async ({ page }) => {
  await seed(page)
  await page.goto('/#/settings')
  await page.getByRole('button', { name: en['export.open'], exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await page.evaluate(() => { (window as unknown as { __kept: number }).__kept = 1 })
  const field = dialog.locator('input[type="password"]')
  await field.fill('a long enough passphrase')
  await field.press('Enter')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1)
  await expect(field).toHaveValue('a long enough passphrase')
  // Nothing was exported: neither action ran (a default submit button would have clicked Download).
  await expect(dialog.getByRole('button', { name: en['export.download'], exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: en['export.busy'], exact: true })).toHaveCount(0)
  // On this seeded record an export that ran would end in an error (no share to open); give it the
  // time to, then require that nothing was reported.
  await page.waitForTimeout(2000)
  await expect(dialog.locator('.unlock-err')).toHaveCount(0)
})

test('the passphrase is paired with this vault\'s hidden username, outside the tab order', async ({ page }) => {
  await seed(page)
  await page.goto('/#/settings')
  await page.getByRole('button', { name: en['rotate.open'], exact: true }).click()
  const dialog = page.getByRole('dialog')
  const user = dialog.locator('form input[autocomplete="username"]')
  await expect(user).toHaveCount(1)
  await expect(user).toHaveValue(/^Common Treasury · [0-9a-f]{4}$/)
  // The opening focus is the real field (it comes from autoFocus; no Tab is pressed here, so this
  // does not prove Tab skips the hidden one, which the Dialog's dom test does).
  await expect(dialog.locator('input[type="password"]').first()).toBeFocused()
  await expect(dialog.locator('form > :first-child')).toHaveAttribute('autocomplete', 'username')
  // Enter in a rotation field does nothing either.
  await page.evaluate(() => { (window as unknown as { __kept: number }).__kept = 1 })
  await page.keyboard.type('whatever')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1)
})
