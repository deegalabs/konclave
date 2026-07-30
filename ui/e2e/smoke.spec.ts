import { test, expect } from '@playwright/test'

// Smoke: every route renders meaningful content and throws no uncaught JS error. This is the
// safety net the screens never had — a redesign/refactor that blanks or crashes a route fails here.
const routes = [
  '/',
  '/vaults',
  '/dashboard',
  '/pay',
  '/payroll',
  '/proposals',
  '/proposal',
  '/ledger',
  '/members',
  '/people',
  '/receive',
  '/create',
  '/proof',
  '/docs',
  '/net',
  '/signer',
]

for (const route of routes) {
  test(`renders ${route} with no uncaught error`, async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    await page.goto(`/#${route}`)
    await expect(page.locator('body')).toBeVisible()

    // The route shows real content, not a blank shell or an error boundary.
    const text = (await page.locator('body').innerText()).trim()
    expect(text.length, `expected substantive content on ${route}`).toBeGreaterThan(40)

    expect(pageErrors, `uncaught errors on ${route}:\n${pageErrors.join('\n')}`).toEqual([])
  })
}
