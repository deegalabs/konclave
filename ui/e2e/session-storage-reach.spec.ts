import { test, expect } from '@playwright/test'

// EXPERIMENT for #446 option A: keep the vault's read secret `S` in `sessionStorage`.
//
// That it survives F5 is not in doubt. What decides whether A is worth its cost - it is the only
// option that puts a read capability in PLAINTEXT at rest - is how far it actually reaches. A fix
// that works in one tab and silently does not in the next is a worse experience than no fix, because
// the member cannot predict when they will be asked.

const KEY = 'konclave.e2e.S'
const VALUE = 'secret-S'

test('sessionStorage survives a reload', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [KEY, VALUE] as const)
  await page.reload()
  expect(await page.evaluate((k) => sessionStorage.getItem(k), KEY)).toBe(VALUE)
})

test('but it does NOT reach a second tab, which is the limit of option A', async ({ context }) => {
  // The member opens the vault in a new tab and is asked for the passphrase again, with no way to
  // tell why this time and not last time. `localStorage` would cross tabs - and would also outlive
  // the browser, turning a session-scoped read capability into a permanent one on disk.
  const first = await context.newPage()
  await first.goto('/')
  await first.evaluate(([k, v]) => sessionStorage.setItem(k, v), [KEY, VALUE] as const)

  const second = await context.newPage()
  await second.goto('/')
  expect(
    await second.evaluate((k) => sessionStorage.getItem(k), KEY),
    'if this ever returns the value, sessionStorage stopped being per-tab',
  ).toBeNull()
})
