import { test, expect } from '@playwright/test'

import { en } from '../src/i18n/en'

// The vault card's badges on a phone, in a real browser: a tap opens a badge's tip and leaves it open,
// and the tip sits inside the card instead of running off the screen's edge.

async function seed(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('konclave.locale', 'en')
    const now = Math.floor(Date.now() / 1000)
    localStorage.setItem('konclave.status.demo', JSON.stringify({
      totalZat: 80_000, spendableZat: 80_000, reservedZat: 0, balanceAt: now - 600, proposalsAt: now - 60, openCount: 2, lastActivity: now - 2 * 86_400,
    }))
    const req = indexedDB.open('konclave', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const tx = req.result.transaction('vaults', 'readwrite')
      tx.objectStore('vaults').put({ id: 'demo', name: 'Common Treasury', roster: ['Alice', 'Bob'], groupKey: 'ab'.repeat(32), address: 'u1demo', createdAt: Date.now(), threshold: 2, total: 2 })
    }
  })
  await page.route('**/api/health**', (r) => r.fulfill({ status: 500, json: { error: 'no bridge' } }))
}

test.describe('vault card badges on a phone', () => {
  test.use({ hasTouch: true, isMobile: true })
  for (const width of [320, 360, 390]) {
    test(`a tap opens the tip, and it stays inside the card at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await seed(page)
      await page.goto('/#/vaults')
      const badge = page.getByRole('button', { name: en['vaults.badgeOpen']!.replace('{n}', '2') })
      await badge.tap()
      const tip = page.getByRole('tooltip', { name: en['vaults.tipOpen'] })
      await expect(tip).toBeVisible()
      // Still on the list: a tap on a badge is not a tap on the vault.
      await expect(page).toHaveURL(/#\/vaults/)
      const card = await page.locator('.rd-card').first().boundingBox()
      const box = await tip.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(card!.x)
      expect(box!.x + box!.width).toBeLessThanOrEqual(card!.x + card!.width + 0.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
  }
})
