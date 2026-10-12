import { test, expect } from '@playwright/test'

// A vault creation in progress loses this device's part of the key if the dialog closes: nothing is
// saved before the passphrase step. Driven through the real screen, so the whole path is covered -
// the rule, the dialog's Esc and backdrop, the host that asks instead of closing - not one line of it.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))
  // No network is needed to reach the invite step; keep it that way.
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4173)/, (r) => r.abort())
})

// The join door opens the same creation dialog in every build (Create needs a configured
// coordinator); from the invite on, the guard is the same for joiner and creator.
async function openDialog(page: import('@playwright/test').Page) {
  await page.goto('/#/vaults')
  await page.getByRole('button', { name: /join by invite/i }).click()
  await expect(page.locator('.create-card')).toBeVisible()
}

async function toInvite(page: import('@playwright/test').Page) {
  await openDialog(page)
  await page.locator('#cv-join-name').fill('Bia')
  await page.locator('#cv-join-invite').fill('0123456789ABCDEFGHJKMNPQRS')
  await page.locator('#cv-join-pin').fill('4821')
  await page.getByRole('button', { name: /join the vault/i }).click()
  await expect(page.locator('.cv-cancel')).toBeVisible()
}

test('before the invite, Esc still closes the dialog', async ({ page }) => {
  await openDialog(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.create-card')).toHaveCount(0)
})

test('closing before the invite, by Esc or outside click, lets the dialog open again', async ({ page }) => {
  await openDialog(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.create-card')).toHaveCount(0)
  await page.getByRole('button', { name: /join by invite/i }).click()
  await page.waitForTimeout(400) // a dialog that closes itself on opening would be gone by now
  await expect(page.locator('.create-card')).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(page.locator('.create-card')).toHaveCount(0)
  await page.getByRole('button', { name: /join by invite/i }).click()
  await page.waitForTimeout(400)
  await expect(page.locator('.create-card')).toBeVisible()
})

test('during a creation, Esc asks instead of closing, and a second Esc keeps creating', async ({ page }) => {
  await toInvite(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.create-card')).toBeVisible()
  await expect(page.locator('#cv-leave-q')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#cv-leave-q')).toHaveCount(0)
  await expect(page.locator('.create-card')).toBeVisible()
  await expect(page.locator('.cv-cancel')).toBeFocused()
})

test('during a creation, a backdrop click asks; keep stays, cancel closes', async ({ page }) => {
  await toInvite(page)
  await page.mouse.click(5, 5)
  await expect(page.locator('#cv-leave-q')).toBeVisible()
  await page.getByRole('button', { name: /keep creating/i }).click()
  await expect(page.locator('.create-card')).toBeVisible()
  await page.locator('.cv-cancel').click()
  await page.getByRole('button', { name: /cancel and lose my part/i }).click()
  await expect(page.locator('.create-card')).toHaveCount(0)
})

test('during a creation, closing the tab asks the browser to confirm', async ({ page }) => {
  await toInvite(page)
  let asked = false
  page.on('dialog', async (d) => { asked = d.type() === 'beforeunload'; await d.dismiss() })
  await page.close({ runBeforeUnload: true })
  await expect.poll(() => asked).toBe(true)
})

// An invite link opens the join form inside the vaults dialog (where a joiner gets the name, the
// close guard and the backup step), and the invite leaves the address bar once read. Links sent
// before this change (#/net?join=) land in the same place.
for (const route of ['/#/vaults?join=', '/#/net?join=']) {
  test(`an invite link (${route}) opens the join dialog with the code filled, and leaves the address bar`, async ({ page }) => {
    const code = '0123456789ABCDEFGHJKMNPQRS'
    await page.goto(route + code)
    await expect(page.locator('.create-card')).toBeVisible()
    await expect(page.locator('#cv-join-invite')).toHaveValue(code)
    await expect(page.locator('#cv-join-name')).toBeFocused() // the first empty required field
    await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('join=')
  })
}

test('an invite link with a bad code opens the join dialog and says so there', async ({ page }) => {
  await page.goto('/#/vaults?join=NOT-AN-INVITE')
  await expect(page.locator('.create-card')).toBeVisible()
  await expect(page.locator('#cv-join-invite-hint')).toContainText(/does not look like a whole invite/i)
  // Focus goes where the problem is, so a screen reader hears the hint with the field.
  await expect(page.locator('#cv-join-invite')).toBeFocused()
  await expect(page.locator('#cv-join-invite')).toHaveAttribute('aria-invalid', 'true')
})

test('a member joins only with a name and the PIN', async ({ page }) => {
  await page.goto('/#/vaults?join=0123456789ABCDEFGHJKMNPQRS')
  const join = page.getByRole('button', { name: /join the vault/i })
  await page.locator('#cv-join-pin').fill('4821')
  await expect(join).toBeDisabled()
  await expect(page.locator('#cv-join-why')).toContainText(/your name/i)
  await page.locator('#cv-join-name').fill('   ')
  await expect(join).toBeDisabled()
  await page.locator('#cv-join-name').fill('Bia')
  await expect(join).toBeEnabled()
})

test('the creator also names itself before going on', async ({ page }) => {
  await page.goto('/#/vaults')
  await page.getByRole('button', { name: /join by invite/i }).click()
  await page.getByRole('button', { name: /create a new vault/i }).click()
  await page.locator('#cv-vault-name').fill('Guard')
  const next = page.locator('.create-card button.cv-primary').first()
  await expect(next).toBeDisabled()
  await expect(page.locator('#cv-create-why')).toContainText('your name')
  await page.locator('#cv-create-name').fill('   ')
  await expect(next).toBeDisabled()
  await page.locator('#cv-create-name').fill('Ana')
  await expect(next).toBeEnabled()
  await expect(page.locator('#cv-create-why')).toHaveText('')
})
