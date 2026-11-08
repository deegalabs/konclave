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
        groupKey: 'ab'.repeat(32), address: 'u1demo', createdAt: Date.now(), threshold: 2, total: 2,
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
      // whatever clips further up. Setting scrollLeft rules out `overflow: visible`; it still passes on
      // `overflow: hidden`, which the arrow keys below catch.
      expect(await wrap.evaluate((w) => { w.scrollLeft = 80; return w.scrollLeft > 0 })).toBe(true)
      // And from the keyboard: focused, the frame scrolls with the arrow keys.
      await wrap.evaluate((w) => { w.scrollLeft = 0 })
      await wrap.focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => wrap.evaluate((w) => w.scrollLeft)).toBeGreaterThan(0)
      const frame = await wrap.boundingBox()
      expect(frame!.x + frame!.width).toBeLessThanOrEqual(width + 0.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }
})

// On a desktop keyboard: the disclosure opens without a pointer, and the table's frame, which
// scrolls on a narrow screen, is a named region the keyboard can reach (the phone test scrolls it).
test.describe('the trust disclosure from the keyboard', () => {
  test('Enter on the summary opens it, and the frame is a named, focusable region', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await seed(page)
    await page.goto('/#/settings')
    const summary = page.locator('details.trust-details > summary')
    await expect(summary).toBeVisible()
    await summary.focus()
    await expect(summary).toBeFocused()
    // focus() reaches even an element out of the tab order: check it is in it, and closed before Enter.
    await expect(summary).toHaveJSProperty('tabIndex', 0)
    await expect(page.locator('details.trust-details')).toHaveJSProperty('open', false)
    await page.keyboard.press('Enter')
    await expect(page.locator('details.trust-details')).toHaveJSProperty('open', true)
    const region = page.getByRole('region', { name: ptBR['set.secTrust'] })
    await expect(region).toBeVisible()
    await expect(region).toHaveAttribute('aria-labelledby', 's-trust')
    await expect(region).toHaveAttribute('tabindex', '0')
    await expect(region.locator('table.trust-grid')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(region).toBeFocused()
    // Space closes it again: the native control, both keys.
    await summary.focus()
    await page.keyboard.press('Space')
    await expect(page.locator('details.trust-details')).toHaveJSProperty('open', false)
  })
})
