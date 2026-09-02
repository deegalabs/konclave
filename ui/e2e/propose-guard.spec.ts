import { test, expect } from '@playwright/test'

import { en } from '../src/i18n/en'
import { ptBR } from '../src/i18n/pt-BR'
import { blockMessageKey, type ProposeBlock } from '../src/propose-guard'

// The propose gate, driven through the real screen in a browser.
//
// Unit tests cover the rule (`propose-guard.test.ts`); this covers the thing unit tests cannot see:
// that the button a member actually clicks reflects it, and that making the gate fail CLOSED did not
// take away the ability to propose a perfectly good payment. The happy path is the first test on
// purpose - it is the one that must not break.
//
// Run against BOTH locales. The gate was made to fail closed, and a disabled button with no reason
// is worse than the old behaviour of enabling it and failing later - so the copy is part of the fix,
// not decoration, and copy that only exists in English would leave a pt-BR member exactly where the
// fix was meant to rescue them. The expected strings are read from the dictionaries through
// `blockMessageKey`, so this exercises the real chain (rule -> key -> dictionary -> screen) and
// fails if a key is renamed on one side only, instead of restating the translations here.

const LOCALES = [
  { id: 'en', dict: en },
  { id: 'pt-BR', dict: ptBR },
] as const

/** The copy the screen must show for `block`, taken from the dictionary rather than hardcoded. */
function message(dict: Record<string, string>, block: ProposeBlock): string {
  const key = blockMessageKey(block)
  if (!key) throw new Error(`no message key for block ${String(block)}`)
  const text = dict[key]
  if (!text) throw new Error(`key ${key} is missing from the dictionary`)
  return text
}

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

/** A vault that synced fine and simply has nothing to spend - not the same as a balance we failed to read. */
const EMPTY = {
  configured: true,
  total_zat: 0,
  total_zec: '0.0000',
  spendable_zat: 0,
  spendable_zec: '0.0000',
}

type Balance = 'ok' | 'unreadable' | 'zero'

/** Stub everything the payment screen reads. `balance` is per-test so it can fail or come back empty. */
async function stub(page: import('@playwright/test').Page, locale: string, balance: Balance) {
  await page.addInitScript((l) => localStorage.setItem('konclave.locale', l), locale)
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  await page.route('**/api/vault**', (r) => r.fulfill({ json: { vault: VAULT } }))
  await page.route('**/api/beneficiaries**', (r) => r.fulfill({ json: { beneficiaries: [] } }))
  await page.route('**/api/balance**', (r) => {
    if (balance === 'unreadable') return r.fulfill({ status: 500, json: { error: 'unavailable' } })
    return r.fulfill({ json: balance === 'zero' ? EMPTY : FUNDED })
  })
}

const amount = (page: import('@playwright/test').Page) => page.locator('input.payamt-in')

/** The recipient field is a combobox; type into its text input. */
async function fillRecipient(page: import('@playwright/test').Page) {
  await page.getByRole('combobox').first().fill(RECIPIENT)
}

for (const { id: locale, dict } of LOCALES) {
  const proposeBtn = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: dict['payment.proposeBtn'], exact: true })

  test.describe(`propose gate · ${locale}`, () => {
    test('a fundable payment can still be proposed - the gate did not break the happy path', async ({ page }) => {
      await stub(page, locale, 'ok')
      await page.goto('/#/pay')
      await fillRecipient(page)
      await amount(page).fill('0.5')
      await expect(proposeBtn(page)).toBeEnabled()
    })

    test('a comma decimal blocks, and says why instead of leaving a dead button', async ({ page }) => {
      // `parseZecToZat` rejects a comma. The screen used to enable the button anyway (a looser
      // `parseFloat` in `canSubmit`), send it, and fail afterwards. Now it blocks - and because a
      // silent disabled button would be worse than the old behaviour for a pt-BR member, it explains.
      await stub(page, locale, 'ok')
      await page.goto('/#/pay')
      await fillRecipient(page)
      await amount(page).fill('0,5')
      await expect(proposeBtn(page)).toBeDisabled()
      await expect(page.getByText(message(dict, 'amount'))).toBeVisible()
    })

    test('an unreadable balance blocks instead of silently waving the payment through', async ({ page }) => {
      // The fail-open: `available` falls back to '-', which does not parse, which made the
      // over-balance test false, which the screen read as "all clear".
      await stub(page, locale, 'unreadable')
      await page.goto('/#/pay')
      await fillRecipient(page)
      await amount(page).fill('0.5')
      await expect(proposeBtn(page)).toBeDisabled()
      await expect(page.getByText(message(dict, 'balance-unknown'))).toBeVisible()
    })

    test('a vault with nothing spendable says so, rather than blaming the amount', async ({ page }) => {
      // Separate from `over-balance` on purpose: at zero spendable the "lower the amount" remedy is
      // impossible, so the honest answer is that there is nothing to spend yet. Separate from
      // `balance-unknown` too - we read the balance fine, it is simply empty.
      await stub(page, locale, 'zero')
      await page.goto('/#/pay')
      await fillRecipient(page)
      await amount(page).fill('0.5')
      await expect(proposeBtn(page)).toBeDisabled()
      await expect(page.getByText(message(dict, 'no-funds'))).toBeVisible()
    })

    test('an untouched form shows no warning', async ({ page }) => {
      // An empty amount also parses to null; warning about it before the member has typed anything
      // would be noise.
      await stub(page, locale, 'ok')
      await page.goto('/#/pay')
      await expect(page.getByText(message(dict, 'amount'))).toHaveCount(0)
    })
  })
}
