import { test, expect, type Page } from '@playwright/test'

// The mobile layout net. Two failure modes are invisible to a unit test and easy to reintroduce:
//
//   1. the page scrolls sideways - something is wider than the phone;
//   2. a control is CROPPED - it sits in a box with `overflow:hidden` whose content does not fit,
//      so the user reads half a label. This is what turned the PT/EN toggle into "PT | E": a
//      `min-width:0` on the header let the toggle shrink, and its own `overflow:hidden` (there to
//      round the corners) guillotined the second button.
//
// Both are measured in a real browser at real phone widths, on the shipped routes with data
// stubbed in - a screen that renders empty hides exactly the overflow this is looking for.
// `/lab` demos are out of scope: they are not part of the product surface.

const ROUTES = [
  '/', '/vaults', '/dashboard', '/receive', '/pay', '/payroll', '/proposals', '/proposal',
  '/activity', '/ledger', '/ceremonies', '/members', '/people', '/settings', '/create', '/proof',
]
const WIDTHS = [320, 360, 390]

const ADDR =
  'u1exampledeadbeefcafe000000000000000000000000000000000000000000000000000000000000000000000000d406dr'

// Long names and large amounts on purpose: layout breaks on the widest realistic content,
// never on the placeholder.
const proposal = (id: string, state: string, zec: string, zat: number, who: string, kind = 'payment') => ({
  id, vault_id: 'demo', kind, state, proposer: who, value_zat: zat, value_zec: zec,
  to_address: ADDR, is_public: false, expiry_unix: 4_000_000_000, created_at: 1_700_000_000,
  approvals: state === 'open' ? ['Alice'] : ['Alice', 'Bob'], refusals: [],
  approvals_count: state === 'open' ? 1 : 2,
})

const PROPOSALS = [
  proposal('p1', 'open', '0.0120', 1_200_000, 'Alice'),
  proposal('p2', 'ready', '1.5000', 150_000_000, 'Bob'),
  proposal('p3', 'sent', '0.0500', 5_000_000, 'Carolina Nascimento'),
  proposal('p4', 'confirmed', '12.3456', 1_234_560_000, 'Alice'),
  proposal('p5', 'ready', '0.0033', 330_000, 'Bob', 'payroll'),
]

const VAULT = {
  id: 'demo', name: 'Tesouraria Comum da Associacao', threshold: 3, total: 4, members: 4,
  member_list: [
    { name: 'Alice', pubkey: 'a' }, { name: 'Bob', pubkey: 'b' },
    { name: 'Carolina Nascimento', pubkey: 'c' }, { name: 'Daniel', pubkey: 'd' },
  ],
  group_pubkey: 'f'.repeat(64), orchard_address: ADDR, locked: false,
}

async function stubApi(page: Page) {
  await page.addInitScript(() => {
    try { localStorage.setItem('konclave.vault', 'demo') } catch { /* storage unavailable */ }
  })
  const json = (body: unknown) => (r: { fulfill: (o: { json: unknown }) => unknown }) => r.fulfill({ json: body })
  await page.route('**/api/health**', json({ status: 'ok', name: 'konclave', version: 'e2e' }))
  await page.route('**/api/vaults**', json({ vaults: [VAULT] }))
  await page.route('**/api/vault**', json({ vault: VAULT }))
  await page.route('**/api/balance**', json({
    configured: true, total_zat: 200_000_000, total_zec: '2.0000',
    spendable_zec: '1.8000', spendable_zat: 180_000_000, pending_zec: '0.2000', reserved_zat: 20_000_000,
  }))
  await page.route('**/api/ledger**', json({ proposals: PROPOSALS }))
  await page.route('**/api/proposals/p2**', json({ proposal: PROPOSALS[1], lines: [] }))
  await page.route('**/api/proposals**', json({ proposals: PROPOSALS }))
  await page.route('**/api/ceremonies**', json({ ceremonies: [] }))
  await page.route('**/api/**', json({}))
}

/** Runs in the page: everything sticking out of the viewport, and every box cropping its own
 *  content. `.top-progress` is skipped - it is an indeterminate loader whose bar is MEANT to be
 *  clipped as it slides. An `text-overflow:ellipsis` box is skipped too: that truncation is a
 *  deliberate, signposted one. Third: a child spilling sideways out of a parent that does not
 *  clip - the overlap case, which neither of the other two can see. */
function measure() {
  const clipped: string[] = []
  const wide: string[] = []
  const escaped: string[] = []
  const vw = document.documentElement.clientWidth
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.closest('.top-progress')) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const name = el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')
    const hidden = cs.overflowX === 'hidden' || cs.overflow === 'hidden'
    if (hidden && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis') {
      const text = ((el as HTMLElement).innerText || '').trim().slice(0, 36).replace(/\n/g, ' / ')
      clipped.push(`${name} crops ${el.scrollWidth - el.clientWidth}px of "${text}"`)
    }
    if (r.right > vw + 1) wide.push(`${name} +${Math.round(r.right - vw)}px past the edge`)

    // A child that will not shrink inside a right-justified box grows LEFTWARD out of it and is
    // painted over its neighbour. Nothing leaves the viewport and nothing is cropped, so neither
    // check above sees it - that is how the header controls came to cover the wordmark, where the
    // icon escaped `.lh-right` and landed on `.brand` one level up.
    //
    // Escaping a parent is not itself a fault (a zero-width or collapsed container makes every
    // child "escape", and negative margins are used on purpose), so escape alone is not reported.
    // What is reported is an escape that LANDS on something: the element overlapping one of its
    // parent's siblings, which normal flow never produces deliberately.
    const par = el.parentElement
    const inFlow = (k: Element) => {
      const kcs = getComputedStyle(k)
      // A wrapped `display:inline` box reports the UNION of its line boxes, so two of them in one
      // paragraph always look overlapped while nothing overlaps on screen - not comparable here.
      if (kcs.position !== 'static' || kcs.display === 'none' || kcs.display === 'inline') return false
      const kr = k.getBoundingClientRect()
      return kr.width > 1 && kr.height > 1
    }
    if (par?.parentElement && cs.position === 'static' && !el.closest('svg') && inFlow(el)) {
      const pr = par.getBoundingClientRect()
      if (Math.max(pr.left - r.left, r.right - pr.right) > 1) {
        for (const uncle of Array.from(par.parentElement.children)) {
          if (uncle === par || !inFlow(uncle)) continue
          const u = uncle.getBoundingClientRect()
          const dx = Math.min(r.right, u.right) - Math.max(r.left, u.left)
          const dy = Math.min(r.bottom, u.bottom) - Math.max(r.top, u.top)
          if (dx > 1 && dy > 1) {
            const lab = uncle.tagName.toLowerCase() + (typeof uncle.className === 'string' && uncle.className.trim()
              ? '.' + uncle.className.trim().split(/\s+/)[0] : '')
            escaped.push(`${name} spills out of its box and covers ${lab} by ${Math.round(dx)}x${Math.round(dy)}px`)
          }
        }
      }
    }
  }
  return { overflow: document.documentElement.scrollWidth - vw, clipped, wide: wide.slice(0, 5), escaped }
}

for (const width of WIDTHS) {
  test(`no sideways scroll and no cropped control at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await stubApi(page)

    const problems: string[] = []
    for (const route of ROUTES) {
      await page.goto(`/#${route}`, { waitUntil: 'networkidle' })
      const r = await page.evaluate(measure)
      if (r.overflow > 1) problems.push(`${route}: page scrolls ${r.overflow}px sideways [${r.wide.join('; ')}]`)
      for (const c of r.clipped) problems.push(`${route}: ${c}`)
      for (const e of r.escaped) problems.push(`${route}: ${e}`)
    }

    expect(problems, `layout problems at ${width}px:\n  ${problems.join('\n  ')}`).toEqual([])
  })
}
