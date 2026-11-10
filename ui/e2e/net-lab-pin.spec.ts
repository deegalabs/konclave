import { test, expect } from '@playwright/test'

// The standalone /net cards open a creation room too, so they say the PIN minimum the same way the
// main forms do: on the field, as its description, and on the button the field holds closed.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))
  await page.route(/^(?!http:\/\/127\.0\.0\.1:\d+\/)/, (r) => r.abort())
})

test('the /net PIN fields and buttons say what the PIN is', async ({ page }) => {
  await page.goto('/#/net')
  // Creating: the app's PIN first; the own-PIN field, once chosen, says the minimum.
  await page.getByRole('button', { name: /choose my own pin instead/i }).click()
  const cards = page.locator('.net-card')
  const createPin = cards.nth(0).getByRole('textbox', { name: /room pin/i })
  const joinPin = cards.nth(1).getByRole('textbox', { name: /room pin/i })
  await expect(createPin).toHaveAccessibleDescription(/at least 6 characters/i)
  await expect(joinPin).toHaveAccessibleDescription(/usually 13 digits/i)
  await createPin.fill('48219')
  await expect(page.getByRole('button', { name: /generate invite/i })).toHaveAccessibleDescription(/at least 6 characters/i)
  await expect(page.getByRole('button', { name: /join with the code/i })).toHaveAccessibleDescription(/usually 13 digits/i)
})

// The main forms: the join PIN field says the minimum itself, with or without an invite link, and
// the create button is described by the PIN help.
test('the join PIN field says what the PIN usually is, opened from a link', async ({ page }) => {
  await page.goto('/#/vaults?join=0123456789ABCDEFGHJKMNPQRS')
  await expect(page.locator('#cv-join-pin')).toHaveAccessibleDescription(/usually 13 digits/i)
  // The note that the link filled the invite belongs to the invite field, not to the PIN.
  await expect(page.locator('#cv-join-invite')).toHaveAccessibleDescription(/filled from your invite link/i)
})

test('the join PIN field says what the PIN usually is, opened by hand', async ({ page }) => {
  await page.goto('/#/vaults')
  await page.getByRole('button', { name: /join by invite/i }).click()
  await expect(page.locator('#cv-join-pin')).toHaveAccessibleDescription(/usually 13 digits/i)
})

test('the create button is described by the PIN help', async ({ page }) => {
  await page.goto('/#/vaults')
  await page.getByRole('button', { name: /join by invite/i }).click()
  await page.getByRole('button', { name: /create a new vault/i }).click()
  await page.locator('#cv-vault-name').fill('Probe')
  await page.locator('#cv-create-name').fill('Ana')
  await page.locator('.create-card button.cv-primary').first().click()
  await expect(page.getByRole('button', { name: /generate invite/i })).toHaveAccessibleDescription(/say this PIN to each member on a call/i)
  await page.getByRole('button', { name: /choose my own pin instead/i }).click()
  await expect(page.getByRole('button', { name: /generate invite/i })).toHaveAccessibleDescription(/at least 6 characters/i)
})
