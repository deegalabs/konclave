import { test, expect } from '@playwright/test'

import { en } from '../src/i18n/en'
import { ptBR } from '../src/i18n/pt-BR'

// #307, through the real screen: the browser's answer to "will you keep this share?" used to be
// requested and thrown away, so a member on a browser that declines could lose their seat and never
// be told. These drive the Dashboard with `navigator.storage` forced into each answer.
//
// Both locales, because a warning that only exists in English does not warn a pt-BR member, and the
// whole point of this issue is that the person is told.

const RECIPIENT =
  'u1exampledeadbeefcafe000000000000000000000000000000000000000000000000000000000000000000000000d406dr'

const VAULT = {
  id: 'demo', name: 'Common Treasury', threshold: 2, total: 3, members: 3,
  member_list: [{ name: 'Alice', pubkey: 'a' }, { name: 'Bob', pubkey: 'b' }, { name: 'Carol', pubkey: 'c' }],
  group_pubkey: '', orchard_address: RECIPIENT, locked: false,
}
const FUNDED = {
  configured: true, total_zat: 200_000_000, total_zec: '2.0000',
  spendable_zat: 200_000_000, spendable_zec: '2.0000',
}

type Answer = 'granted' | 'refused' | 'no-api'

/** Force `navigator.storage` into one answer before any app code runs. */
async function stub(page: import('@playwright/test').Page, locale: string, answer: Answer) {
  await page.addInitScript(
    ([l, a]) => {
      localStorage.setItem('konclave.locale', l as string)
      localStorage.setItem('konclave.selectedVault', 'demo')
      if (a === 'no-api') {
        Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
        return
      }
      const granted = a === 'granted'
      Object.defineProperty(navigator, 'storage', {
        value: { persisted: async () => granted, persist: async () => granted },
        configurable: true,
      })
    },
    [locale, answer] as const,
  )
  await page.route('**/api/health**', (r) => r.fulfill({ json: { status: 'ok', name: 'konclave', version: 'e2e' } }))
  await page.route('**/api/vault**', (r) => r.fulfill({ json: { vault: VAULT } }))
  await page.route('**/api/balance**', (r) => r.fulfill({ json: FUNDED }))
  await page.route('**/api/proposals**', (r) => r.fulfill({ json: { proposals: [] } }))
  await page.route('**/api/beneficiaries**', (r) => r.fulfill({ json: { beneficiaries: [] } }))
}

for (const { id: locale, dict } of [
  { id: 'en', dict: en },
  { id: 'pt-BR', dict: ptBR },
] as const) {
  const warning = (page: import('@playwright/test').Page) =>
    page.getByText(dict['dashboard.evictionBanner'])

  test.describe(`eviction warning · ${locale}`, () => {
    test('a browser that refuses to keep the share says so, in this locale', async ({ page }) => {
      await stub(page, locale, 'refused')
      await page.goto('/#/dashboard')
      await expect(warning(page)).toBeVisible()
      await expect(page.getByRole('link', { name: dict['dashboard.evictionCta'] })).toBeVisible()
    })

    test('a browser that granted persistence is not nagged', async ({ page }) => {
      // The other half: a warning that always shows is a warning nobody reads.
      await stub(page, locale, 'granted')
      await page.goto('/#/dashboard')
      await expect(warning(page)).toHaveCount(0)
    })

    test('a browser with no Storage API warns too, because it promised nothing', async ({ page }) => {
      // Not knowing is not the same as safe. A browser that cannot answer cannot guarantee, and
      // the cost of a missed warning here is someone's key share.
      await stub(page, locale, 'no-api')
      await page.goto('/#/dashboard')
      await expect(warning(page)).toBeVisible()
    })
  })
}
