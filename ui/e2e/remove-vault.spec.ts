import { test, expect } from '@playwright/test'

import { en } from '../src/i18n/en'
import { ptBR } from '../src/i18n/pt-BR'

// #426, through the real screen. Until this landed there was NO way to remove a vault from a
// device on the shipping path, while `settings.removeSoonWhy` told people to come here and do it.
// The copy for the flow had existed in both dictionaries the whole time, unused.
//
// These drive the destructive path, so they check the guard as hard as the action: the button must
// stay disabled until the vault's name is typed exactly, and cancelling must leave the vault alone.

const VAULT_NAME = 'Common Treasury'

/** Seed a local vault record. `listVaults` does a bare getAll(), so the public fields suffice. */
async function seed(page: import('@playwright/test').Page, locale: string) {
  await page.addInitScript(
    ([l, name]) => {
      localStorage.setItem('konclave.locale', l as string)
      const req = indexedDB.open('konclave', 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' })
      }
      req.onsuccess = () => {
        const tx = req.result.transaction('vaults', 'readwrite')
        tx.objectStore('vaults').put({
          id: 'demo', name, roster: ['Alice', 'Bob'], groupKey: 'ab'.repeat(32),
          address: 'u1demo', createdAt: Date.now(),
        })
      }
    },
    [locale, VAULT_NAME] as const,
  )
  // The bridge is absent on the web, so the list degrades to the on-device vaults alone.
  await page.route('**/api/health**', (r) => r.fulfill({ status: 500, json: { error: 'no bridge' } }))
}

for (const { id: locale, dict } of [
  { id: 'en', dict: en },
  { id: 'pt-BR', dict: ptBR },
] as const) {
  const card = (page: import('@playwright/test').Page) => page.getByRole('heading', { name: VAULT_NAME })
  const removeBtn = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: dict['dashboard.deleteThisVault'], exact: true })
  const confirmBtn = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: dict['dashboard.deletePermanently'], exact: true })

  test.describe(`remove vault · ${locale}`, () => {
    test('a vault held on this device offers to be removed', async ({ page }) => {
      await seed(page, locale)
      await page.goto('/#/vaults')
      await expect(card(page)).toBeVisible()
      await expect(removeBtn(page)).toBeVisible()
    })

    test('the confirm stays disabled until the name is typed exactly', async ({ page }) => {
      // The guard is the point. This deletes the only copy of a key share on this device, and the
      // member may have no backup, so a mis-tap must not be enough.
      await seed(page, locale)
      await page.goto('/#/vaults')
      await removeBtn(page).click()
      await expect(confirmBtn(page)).toBeDisabled()
      const field = page.getByRole('textbox').last()
      await field.fill('Common')            // a prefix is not the name
      await expect(confirmBtn(page)).toBeDisabled()
      await field.fill('common treasury')   // nor is the wrong case
      await expect(confirmBtn(page)).toBeDisabled()
      await field.fill(VAULT_NAME)
      await expect(confirmBtn(page)).toBeEnabled()
    })

    test('a removal that does not take says so, instead of looking like it worked', async ({ page }) => {
      // The failure that matters. If the delete quietly no-ops and the dialog closes, the member
      // walks away believing a key share is off this device while it is still sitting there - so
      // the screen must stay open and say it failed.
      await seed(page, locale)
      // Make the store's delete a no-op: the transaction still completes cleanly, so only
      // re-reading the store catches it - which is what `forgetVault` does.
      await page.addInitScript(() => {
        IDBObjectStore.prototype.delete = (() => undefined) as unknown as IDBObjectStore['delete']
      })
      await page.goto('/#/vaults')
      await removeBtn(page).click()
      await page.getByRole('textbox').last().fill(VAULT_NAME)
      await confirmBtn(page).click()
      await expect(page.getByText(dict['settings.removeFail'])).toBeVisible()
      await expect(confirmBtn(page)).toBeVisible() // still open, not dismissed
    })

    test('cancelling leaves the vault where it was', async ({ page }) => {
      await seed(page, locale)
      await page.goto('/#/vaults')
      await removeBtn(page).click()
      await page.getByRole('button', { name: dict['common.cancel'], exact: true }).click()
      await expect(card(page)).toBeVisible()
    })

    test('confirming removes it from the list and from storage', async ({ page }) => {
      await seed(page, locale)
      await page.goto('/#/vaults')
      await removeBtn(page).click()
      await page.getByRole('textbox').last().fill(VAULT_NAME)
      await confirmBtn(page).click()
      await expect(card(page)).toHaveCount(0)

      // And it is gone from IndexedDB, not merely from the rendered list. A removal that only
      // hides the row would come back on reload with the share still on the device.
      const left = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const req = indexedDB.open('konclave', 1)
            req.onsuccess = () => {
              const all = req.result.transaction('vaults', 'readonly').objectStore('vaults').getAll()
              all.onsuccess = () => resolve(all.result.length)
              all.onerror = () => resolve(-1)
            }
            req.onerror = () => resolve(-1)
          }),
      )
      expect(left, 'the record must be gone from storage, not just from the screen').toBe(0)
    })
  })
}
