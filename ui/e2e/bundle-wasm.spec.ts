import { test, expect } from '@playwright/test'

// The emitted bundle (not the source vitest runs) loads the wasm and runs a full FROST 2-of-3
// and the reconstruction of a real signed PCZT in it. A bundler upgrade that broke the wasm glue
// or its loading would pass every unit test and fail here.
test('the built bundle loads the wasm and signs with it', async ({ page }) => {
  // Pin the locale so the texts below are stable (the app can default to pt-BR).
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))
  const wasm: number[] = []
  page.on('response', (r) => {
    if (r.url().endsWith('.wasm')) wasm.push(r.status())
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/#/signer')

  // A refusal shows `.demo-result.bad`: fail on it at once rather than wait for a timeout.
  const result = page.locator('.demo-result.ok, .demo-result.bad')

  await page.getByRole('button', { name: 'Sign in the browser' }).click()
  await expect(result.first()).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.demo-result.bad')).toHaveCount(0)
  // "verified" appears only when the aggregated signature verifies inside the wasm.
  await expect(result.first()).toContainText('signature of 64 bytes, verified')

  await page.getByRole('button', { name: 'Read the real PCZT in the browser' }).click()
  await expect(result.nth(1)).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.demo-result.bad')).toHaveCount(0)
  // The amount, the size and the txid prefix of the transaction it reconstructs.
  await expect(result.nth(1)).toContainText('Pays 1 ZEC')
  await expect(result.nth(1)).toContainText('Reconstructed 21156 bytes signed')
  await expect(result.nth(1)).toContainText('069f42604c0f0a')

  expect(wasm.length).toBeGreaterThan(0)
  expect(wasm.every((s) => s === 200)).toBe(true)
  expect(errors).toEqual([])
})
