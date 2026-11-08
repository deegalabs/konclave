import { test, expect, type Page } from '@playwright/test'

import { ptBR } from '../src/i18n/pt-BR'

// The trust panel in Settings, on a phone: the table and its limits sit in a disclosure the member
// opens with a tap, and once open the five-column table scrolls sideways inside its own frame while
// the page itself does not.

const VAULT = { id: 'demo', name: 'Tesouraria Comum', threshold: 2, total: 2, members: 2, member_list: [], locked: false }

async function seed(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('konclave.locale', 'pt-BR')
    localStorage.setItem('konclave.vault', 'demo')
    const req = indexedDB.open('konclave', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const tx = req.result.transaction('vaults', 'readwrite')
      tx.objectStore('vaults').put({
        id: 'demo', name: 'Tesouraria Comum', governance: 'quorum', myName: 'Ana', roster: ['Ana', 'Bia'],
        groupKey: 'ab'.repeat(32), address: 'u1demo', createdAt: Date.now(), threshold: 2, total: 2, secured: true,
      })
    }
  })
  const json = (body: unknown) => (r: { fulfill: (o: { json: unknown }) => unknown }) => r.fulfill({ json: body })
  // Most general first: Playwright gives precedence to the last matching route.
  await page.route('**/api/**', json({}))
  await page.route('**/api/health**', json({ status: 'ok', name: 'konclave', version: 'e2e' }))
  await page.route('**/api/vault**', json({ vault: VAULT }))
  await page.route('**/api/vaults**', json({ vaults: [VAULT] }))
}

test.describe('the trust disclosure on a phone', () => {
  test.use({ hasTouch: true, isMobile: true })
  for (const width of [320, 360, 390]) {
    test(`a tap opens it, and the table scrolls inside its frame at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await seed(page)
      await page.goto('/#/settings')
      const summary = page.locator('details.trust-details > summary')
      await expect(summary).toHaveText(ptBR['trust.disclosure']!)
      const table = page.locator('table.trust-grid')
      await expect(table).toBeHidden()
      await summary.tap()
      await expect(table).toBeVisible()
      const wrap = page.locator('.trust-wrap')
      expect(await wrap.evaluate((w) => w.scrollWidth > w.clientWidth)).toBe(true)
      // Wider than its frame is not enough: the frame must scroll, or the far columns are cut off by
      // whatever clips further up, out of the member's reach.
      expect(await wrap.evaluate((w) => { w.scrollLeft = 80; return w.scrollLeft > 0 })).toBe(true)
      const frame = await wrap.boundingBox()
      expect(frame!.x + frame!.width).toBeLessThanOrEqual(width + 0.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }
})
