import { test, expect } from '@playwright/test'

// The vault home identifies the vault, and the left rail navigates — the everyday path.
test('vault dashboard shows the vault identity', async ({ page }) => {
  await page.goto('/#/dashboard')
  await expect(
    page.getByRole('heading', { name: /Common Treasury|Tesouraria Comum/i }),
  ).toBeVisible()
})

test('the rail navigates between vault screens', async ({ page }) => {
  await page.goto('/#/dashboard')
  await page.getByRole('link', { name: /^(Ledger|Registro)$/ }).click()
  await expect(page).toHaveURL(/#\/ledger/)
  await page.getByRole('link', { name: /^(People|Pessoas)$/ }).click()
  await expect(page).toHaveURL(/#\/people/)
})
