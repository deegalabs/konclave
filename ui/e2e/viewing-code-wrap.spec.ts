import { test, expect } from '@playwright/test'

// The vault card shows the viewing code at its large size, and members compare it group by group, out
// loud. A group split across two lines is read as two groups. Measured in a real browser, at the
// phone widths where the card is narrowest: each group must sit on one line box.

const CODE = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012'

async function seed(page: import('@playwright/test').Page) {
  await page.addInitScript((code) => {
    localStorage.setItem('konclave.locale', 'en')
    const req = indexedDB.open('konclave', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('vaults')) db.createObjectStore('vaults', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const tx = req.result.transaction('vaults', 'readwrite')
      tx.objectStore('vaults').put({
        id: 'demo', name: 'Common Treasury', roster: ['Alice', 'Bob'], groupKey: 'ab'.repeat(32),
        address: 'u1demo', createdAt: Date.now(), threshold: 2, total: 2,
        cp: 3, receiversState: 'verified', viewingFingerprint: code,
      })
    }
  }, CODE)
  await page.route('**/api/health**', (r) => r.fulfill({ status: 500, json: { error: 'no bridge' } }))
}

for (const width of [320, 360, 390]) {
  test(`no group of the viewing code splits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await seed(page)
    await page.goto('/#/vaults')
    const groups = page.locator('.rd-card .fp-code .fp-grp')
    await expect(groups).toHaveCount(5)
    // Lines, not boxes: a browser may draw the hyphen as a run of its own on the SAME line, so count
    // the distinct tops of each group's boxes.
    const lines = await groups.evaluateAll((els) => els.map((e) => new Set([...e.getClientRects()].map((r) => Math.round(r.top))).size))
    expect(lines).toEqual([1, 1, 1, 1, 1])
  })
}
