import { test, expect } from '@playwright/test'

// EXPERIMENT, not a feature test. #446 option B holds the vault's read secret `S` in a worker's
// memory so a reload does not lose it. That whole design rests on one unverified claim: that a
// SharedWorker OUTLIVES a page reload. Its lifetime is implementation-defined, and during an F5
// there is a moment with zero connected clients - exactly when a browser is entitled to collect it.
//
// If it does not survive, B does not exist and no amount of implementation will make it.
//
// The worker is served from a FIXED url on purpose: SharedWorker identity is (script url, name), so
// a blob: url minted per page load would produce a NEW worker every time and the test would fail
// for a reason that has nothing to do with lifetime.

const WORKER_URL = '/e2e-shared-worker.js'

const WORKER_SRC = `
let stored = null
self.onconnect = (e) => {
  const port = e.ports[0]
  port.onmessage = (ev) => {
    if (ev.data.set !== undefined) { stored = ev.data.set; port.postMessage({ ok: true }) }
    else port.postMessage({ value: stored })
  }
  port.start()
}
`

async function serveWorker(page: import('@playwright/test').Page) {
  await page.route(`**${WORKER_URL}`, (r) =>
    r.fulfill({ status: 200, contentType: 'text/javascript', body: WORKER_SRC }))
}

/** Talk to the SharedWorker: `set` stores, absent reads back. */
async function talk(page: import('@playwright/test').Page, set?: string) {
  return await page.evaluate(
    ([url, value]) =>
      new Promise<unknown>((resolve, reject) => {
        try {
          const w = new SharedWorker(url as string, { name: 'konclave-e2e' })
          w.port.onmessage = (ev) => resolve(ev.data)
          w.port.start()
          w.port.postMessage(value === null ? {} : { set: value })
          setTimeout(() => reject(new Error('no answer from the worker')), 4000)
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }),
    [WORKER_URL, set ?? null] as const,
  )
}

test('does a SharedWorker survive a reload when ANOTHER TAB holds it open?', async ({ context }) => {
  // The decisive variant. If it survives here but not alone, the killer is precisely the moment of
  // zero connected clients during F5 - which tells us B works only when the member happens to have
  // a second tab open, i.e. almost never.
  const keeper = await context.newPage()
  await serveWorker(keeper)
  await keeper.goto('/')
  await talk(keeper, 'secret-S')

  const page = await context.newPage()
  await serveWorker(page)
  await page.goto('/')
  expect(await talk(page), 'a second tab sees the same worker').toEqual({ value: 'secret-S' })

  await page.reload()
  await serveWorker(page)
  expect(await talk(page), 'with a keeper tab open, the worker survives').toEqual({
    value: 'secret-S',
  })
  await keeper.close()
})

// The finding, pinned as an executable fact rather than a note someone has to trust. It asserts the
// LIMITATION, so the day a browser keeps the worker alive across a lone reload, this test fails and
// tells us option B became viable. A comment would have rotted silently.
test('a SharedWorker does NOT survive a lone reload, which is what rules option B out', async ({ page }) => {
  await serveWorker(page)
  await page.goto('/')

  const supported = await page.evaluate(() => typeof SharedWorker !== 'undefined')
  expect(supported, 'SharedWorker must exist at all for option B').toBe(true)

  expect(await talk(page, 'secret-S')).toEqual({ ok: true })
  expect(await talk(page), 'the worker answers before any reload').toEqual({ value: 'secret-S' })

  await page.reload()
  await serveWorker(page)

  // Measured 2026-09-05, Chromium: the worker is collected during the moment of zero connected
  // clients, and a FRESH one answers with nothing. That is the normal case - one tab, one reload -
  // so option B does not solve the problem it was chosen for. If this ever returns 'secret-S',
  // this test fails and B is back on the table.
  expect(await talk(page), 'if this now survives, option B (#446) became viable').toEqual({
    value: null,
  })
})
