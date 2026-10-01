import { test, expect } from '@playwright/test'

// The public roadmap points every step at the GitHub issues that track it. The link's name carries
// the issue's title, so a screen reader's list of links reads titles, not forty bare numbers.
// Hovering or focusing a number shows the same title in a card that is only visual (aria-hidden);
// Escape hides it (WCAG 1.4.13: dismissible, hoverable, persistent).

const TITLE_599 = 'A restored vault keeps its viewing key unencrypted in browser storage'
// The hidden part of the name sits in its own box, so the accessibility tree joins it with a space:
// "#599 : title". The patterns accept both.
const NAME_599 = /^#599\s*:/

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))
})

test('a step names the issue behind it, and the card opens on hover and closes on Escape', async ({ page }) => {
  await page.goto('/#/docs/roadmap')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Where Konclave is going/)

  const chip = page.getByRole('link', { name: NAME_599 })
  await expect(chip).toHaveAccessibleName(new RegExp(`^#599\\s*:\\s*${TITLE_599}`))
  await expect(chip).toHaveAttribute('href', 'https://github.com/deegalabs/konclave/issues/599')
  await expect(chip).toHaveAttribute('target', '_blank')
  await expect(chip).toHaveAttribute('rel', /noreferrer/)

  const card = page.locator('.docs-ref-card', { hasText: TITLE_599 })
  await expect(card).toHaveCount(1)
  await expect(card).toHaveAttribute('aria-hidden', 'true')
  await expect(card).toBeHidden()
  await chip.hover()
  await expect(card).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
})

test('keyboard focus opens the card as well', async ({ page }) => {
  await page.goto('/#/docs/roadmap')
  const chip = page.getByRole('link', { name: NAME_599 })
  await chip.focus()
  await expect(page.locator('.docs-ref-card', { hasText: TITLE_599 })).toBeVisible()
})

test('the state of each step is part of its heading', async ({ page }) => {
  await page.goto('/#/docs/roadmap')
  await expect(page.getByRole('heading', { level: 3, name: /Fix our own defects\s*, step 0, now/i })).toBeVisible()
})
