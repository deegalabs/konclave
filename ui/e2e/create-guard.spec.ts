import { test, expect } from '@playwright/test'

// A vault creation in progress loses this device's part of the key if the dialog closes: nothing is
// saved before the passphrase step. Driven through the real screen, so the whole path is covered -
// the rule, the dialog's Esc and backdrop, the host that asks instead of closing - not one line of it.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('konclave.locale', 'en')
    // Protocol 3 joins only through a coordinator that announces it pins (`creationVerdict`): a
    // configured one, whose health answer is the one thing stubbed below.
    localStorage.setItem('konclave.coord.mode', 'custom')
    localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
  })
  // No network is needed to reach the invite step; keep it that way.
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4173)/, (r) => r.abort())
  // Everything else stays cut off.
  await page.route(/^https:\/\/coordinator\.invalid\/api\/health$/, (r) => r.fulfill({ json: { status: 'ok', name: 'konclave-helper', client: { creation: 3 } } }))
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
  await page.locator('#cv-join-pin').fill('482193')
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
  await page.locator('#cv-join-pin').fill('482193')
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

// The room PIN minimum, through the real screen: a short PIN (spaces around it do not count) keeps
// the door closed, and the join form says what is missing.
test('join: a short PIN keeps Join disabled and says why', async ({ page }) => {
  await page.goto('/#/vaults?join=0123456789ABCDEFGHJKMNPQRS')
  const join = page.getByRole('button', { name: /join the vault/i })
  await page.locator('#cv-join-name').fill('Bia')
  for (const pin of ['48219', '      ', '48219     ', '\t48219\n']) {
    await page.locator('#cv-join-pin').fill(pin)
    await expect(join, `pin ${JSON.stringify(pin)}`).toBeDisabled()
    await expect(page.locator('#cv-join-why')).toContainText(/the room PIN/i)
  }
  await page.locator('#cv-join-pin').fill(' 482193 ')
  await expect(join).toBeEnabled()
  await expect(page.locator('#cv-join-why')).toHaveText('')
})

test('create: a short PIN keeps Generate invite disabled', async ({ page }) => {
  await page.goto('/#/vaults')
  await page.getByRole('button', { name: /join by invite/i }).click()
  await page.getByRole('button', { name: /create a new vault/i }).click()
  await page.locator('#cv-vault-name').fill('Probe')
  await page.locator('#cv-create-name').fill('Ana')
  await page.locator('.create-card button.cv-primary').first().click()
  const gen = page.getByRole('button', { name: /generate invite/i })
  // The app's own PIN is the default; a PIN of the member's own is the exception under the minimum.
  await page.getByRole('button', { name: /choose my own pin instead/i }).click()
  for (const pin of ['48219', '      ', '48219     ']) {
    await page.locator('#cv-create-pin').fill(pin)
    await expect(gen, `pin ${JSON.stringify(pin)}`).toBeDisabled()
  }
  await expect(page.locator('#cv-create-pin-help')).toContainText(/at least 6 characters/i)
  await page.locator('#cv-create-pin').fill('482193')
  await expect(gen).toBeEnabled()
})

test('create: the app makes the PIN, so Generate invite is enabled without typing', async ({ page }) => {
  await page.goto('/#/vaults')
  await page.getByRole('button', { name: /join by invite/i }).click()
  await page.getByRole('button', { name: /create a new vault/i }).click()
  await page.locator('#cv-vault-name').fill('Probe')
  await page.locator('#cv-create-name').fill('Ana')
  await page.locator('.create-card button.cv-primary').first().click()
  await expect(page.locator('#cv-create-pin-made [aria-hidden]')).toHaveText(/^\d{4} \d{4} \d{4} \d$/)
  await expect(page.getByRole('button', { name: /generate invite/i })).toBeEnabled()
  await expect(page.locator('#cv-create-pin')).toHaveCount(0)
})
