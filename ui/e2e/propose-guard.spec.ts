import { test, expect } from '@playwright/test'

// The propose gate, driven through the real screen in a browser.
//
// Unit tests cover the rule (`propose-guard.test.ts`); this covers the thing unit tests cannot see:
// that the button a member actually clicks reflects it, and that making the gate fail CLOSED did not
// take away the ability to propose a perfectly good payment. The happy path is the first test on
// purpose - it is the one that must not break.

const RECIPIENT =
  'u1exampledeadbeefcafe000000000000000000000000000000000000000000000000000000000000000000000000d406dr'

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

const FUNDED = {
  configured: true,
  total_zat: 200_000_000,
  total_zec: '2.0000',
  spendable_zat: 200_000_000,
  spendable_zec: '2.0000',
}

/** Stub everything the payment screen reads. `balance` is per-test so it can fail. */
async function stub(page: import('@playwright/test').Page, balance: 'ok' | 'fail') {
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  await page.route('**/api/vault**', (r) => r.fulfill({ json: { vault: VAULT } }))
  await page.route('**/api/beneficiaries**', (r) => r.fulfill({ json: { beneficiaries: [] } }))
  await page.route('**/api/balance**', (r) =>
    balance === 'ok' ? r.fulfill({ json: FUNDED }) : r.fulfill({ status: 500, json: { error: 'unavailable' } }),
  )
}

const amount = (page: import('@playwright/test').Page) => page.locator('input.payamt-in')
const proposeBtn = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /propose payment/i })

/** The recipient field is a combobox; type into its text input. */
async function fillRecipient(page: import('@playwright/test').Page) {
  await page.getByRole('combobox').first().fill(RECIPIENT)
}

test('a fundable payment can still be proposed - the gate did not break the happy path', async ({ page }) => {
  await stub(page, 'ok')
  await page.goto('/#/pay')
  await fillRecipient(page)
  await amount(page).fill('0.5')
  await expect(proposeBtn(page)).toBeEnabled()
})

test('a comma decimal blocks, and says why instead of leaving a dead button', async ({ page }) => {
  // `parseZecToZat` rejects a comma. The screen used to enable the button anyway (a looser
  // `parseFloat` in `canSubmit`), send it, and fail afterwards. Now it blocks - and because a
  // silent disabled button would be worse than the old behaviour for a pt-BR member, it explains.
  await stub(page, 'ok')
  await page.goto('/#/pay')
  await fillRecipient(page)
  await amount(page).fill('0,5')
  await expect(proposeBtn(page)).toBeDisabled()
  await expect(page.getByText(/use a dot for the decimal/i)).toBeVisible()
})

test('an unreadable balance blocks instead of silently waving the payment through', async ({ page }) => {
  // The fail-open: `available` falls back to '-', which does not parse, which made the
  // over-balance test false, which the screen read as "all clear".
  await stub(page, 'fail')
  await page.goto('/#/pay')
  await fillRecipient(page)
  await amount(page).fill('0.5')
  await expect(proposeBtn(page)).toBeDisabled()
  await expect(page.getByText(/balance could not be read/i)).toBeVisible()
})

test('an untouched form shows no warning', async ({ page }) => {
  // An empty amount also parses to null; warning about it before the member has typed anything
  // would be noise.
  await stub(page, 'ok')
  await page.goto('/#/pay')
  await expect(page.getByText(/use a dot for the decimal/i)).toHaveCount(0)
})
