import { test, expect } from '@playwright/test'

import { ptBR } from '../src/i18n/pt-BR'

// The viewing-code card on a vault card ends in the button a member presses once the code matched.
// Its label is long, in Portuguese above all, and at a phone's width it must wrap inside the card
// rather than run past the card's edge.

async function seed(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('konclave.locale', 'pt-BR')
    const req = indexedDB.open('konclave', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const tx = req.result.transaction('vaults', 'readwrite')
      tx.objectStore('vaults').put({
        id: 'demo', name: 'Tesouraria Comum', roster: ['Alice', 'Bob'], groupKey: 'ab'.repeat(32),
        address: 'u1demo', createdAt: Date.now(), threshold: 2, total: 2,
        cp: 3, receiversState: 'verified', viewingFingerprint: 'ABCDE-FGHJK-MNPQR-STVWX-YZ012',
      })
    }
  })
  await page.route('**/api/health**', (r) => r.fulfill({ status: 500, json: { error: 'no bridge' } }))
}

for (const width of [320, 360, 390]) {
  test(`the "compared" button stays inside its card at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await seed(page)
    await page.goto('/#/vaults')
    const button = page.getByRole('button', { name: ptBR['set.viewingCodeSeen'] })
    await expect(button).toBeVisible()
    const card = await page.locator('.fp-card').first().boundingBox()
    const box = await button.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(card!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(card!.x + card!.width + 0.5)
    // The box fitting is not enough: a label that does not wrap spills out of a box that fits.
    expect(await button.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
