import { test, expect } from '@playwright/test'

// The public roadmap points every step at the GitHub issues that track it. The link's name carries
// the issue's title, so a screen reader's list of links reads titles, not forty bare numbers.
// Hovering or focusing a number shows the same title in a card that is only visual (aria-hidden);
// Escape hides it (WCAG 1.4.13: dismissible, hoverable, persistent).

const TITLE_567 = 'Bind each approval to the content it approves, and have the device check it before signing'
// The name is "#567, Open: title". The hidden parts sit in their own boxes, so the accessibility tree
// may join them with spaces; the patterns accept both.
const NAME_567 = /^#567\s*,\s*Open\s*:/

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'en'))
})

test('a step names the issue behind it, and the card opens on hover and closes on Escape', async ({ page }) => {
  await page.goto('/#/docs/roadmap')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Where Konclave is going/)

  const chip = page.getByRole('link', { name: NAME_567 })
  await expect(chip).toHaveAccessibleName(new RegExp(`^#567\\s*,\\s*Open\\s*:\\s*${TITLE_567}`))
  await expect(chip).toHaveAttribute('href', 'https://github.com/deegalabs/konclave/issues/567')
  await expect(chip).toHaveAttribute('target', '_blank')
  await expect(chip).toHaveAttribute('rel', /noreferrer/)

  const card = page.locator('.docs-ref-card', { hasText: TITLE_567 })
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
  const chip = page.getByRole('link', { name: NAME_567 })
  await chip.focus()
  await expect(page.locator('.docs-ref-card', { hasText: TITLE_567 })).toBeVisible()
})

test('the state of each step is part of its heading', async ({ page }) => {
  await page.goto('/#/docs/roadmap')
  await expect(page.getByRole('heading', { level: 3, name: /Fix our own defects\s*, step 0, now/i })).toBeVisible()
})

test('in Portuguese, the name says the state in Portuguese, before the English title', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('konclave.locale', 'pt-BR'))
  await page.goto('/#/docs/roadmap')
  await expect(page.getByRole('link', { name: /^#567\s*,\s*Aberta\s*:/ })).toHaveCount(1)
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 320, height: 720 }, hasTouch: true, isMobile: true })

  // No hover on a touch screen: each ref is two lines in one link, and every ref fits the width (1.4.10).
  // The check is on the refs: the page pager at the bottom overflows at 320 px since before this change.
  test('each ref shows its state and title on two lines, and fits at 320 px', async ({ page }) => {
    await page.goto('/#/docs/roadmap')
    const chip = page.getByRole('link', { name: NAME_567 })
    await expect(chip.locator('.docs-ref-state')).toHaveText('Open')
    await expect(chip.locator('.docs-ref-name')).toHaveCSS('display', 'block')
    await expect(chip.locator('.docs-ref-colon')).toHaveCSS('position', 'absolute')
    const widest = await page.evaluate(() =>
      Math.max(...[...document.querySelectorAll('.docs-stage-refs .docs-ref-chip')].map((a) => a.getBoundingClientRect().right)))
    expect(widest).toBeLessThanOrEqual(320)
  })
})
