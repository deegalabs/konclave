import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// #494. An accessibility audit computed these ratios by hand and got one of them wrong - it proposed
// a border colour it said reached 3.05:1, which actually reaches 1.68:1 and would have shipped
// looking fixed. A contrast value asserted in prose decays the same way any other undocumented
// constant does.
//
// So the ratios are RECOMPUTED here from the tokens themselves. Change a token and this says whether
// the change is legal, without anyone opening a colour picker.
//
// The audit reported every failure as light-theme, dark passing throughout. That held for the pairs
// IT checked; these are the pairs the app actually renders, and two of them failed in DARK - the
// network pill on its own wash, and a control's edge against the page. So both themes are computed
// and neither is assumed, which is the only reason those two were found.

const css = readFileSync(new URL('./lacre.css', import.meta.url), 'utf8')
const docsCss = readFileSync(new URL('./docs.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('./App.css', import.meta.url), 'utf8')

/** The declarations of one App.css rule, by its exact selector. */
function appRule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(appCss)
  if (!m) throw new Error(`no rule for ${selector} in App.css`)
  return m[1]!
}
const tokenIn = (decls: string, prop: string) => new RegExp(`(?:^|[;{\\s])${prop}:\\s*var\\(--([a-z0-9-]+)\\)`).exec(decls)?.[1]

/** The token a docs.css rule paints its TEXT with (`color:`, not `border-left-color:`). */
function docsTextToken(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`${esc}\\s*\\{[^}]*?(?:^|[;{\\s])color:\\s*var\\(--([a-z0-9-]+)\\)`, 'm').exec(docsCss)
  if (!m) throw new Error(`no text colour token for ${selector} in docs.css`)
  return m[1]!
}

/** Pull `--name` out of a `:root`-ish block. `light` reads the bare block, `dark` the stamped one. */
function token(name: string, theme: 'light' | 'dark'): string {
  const block = theme === 'dark'
    ? css.slice(css.indexOf(':root[data-theme="dark"]'))
    : css.slice(css.indexOf(':root{'))
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(block)
  if (!m) throw new Error(`token --${name} not found for ${theme}`)
  return m[1]!.trim()
}

const srgb = (h: string) =>
  [1, 3, 5].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })

const lum = (h: string) => {
  const [r, g, b] = srgb(h) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast. Composited in gamma space first, because every surface here is an alpha wash. */
function ratio(fg: string, bg: string): number {
  const a = lum(fg)
  const b = lum(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** `rgba(r,g,b,a)` over an opaque hex - the fingerprint and danger cards are both washes. */
function over(rgba: string, base: string): string {
  const m = /rgba?\(([^)]+)\)/.exec(rgba)
  if (!m) return rgba
  const parts = m[1]!.split(',').map((x) => x.trim())
  const [r, g, b] = parts
  const a = parts[3] ?? '1'
  const bs = [1, 3, 5].map((i) => parseInt(base.slice(i, i + 2), 16))
  const mix = [r, g, b].map((v, i) => Math.round(Number(v) * Number(a) + bs[i]! * (1 - Number(a))))
  return '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join('')
}

for (const theme of ['light', 'dark'] as const) {
  describe(`contrast · ${theme}`, () => {
    const t = (n: string) => token(n, theme)

    // The surfaces text actually lands on in this app, including the two alpha washes.
    const page = () => t('surface-0')
    const well = () => t('surface-2')
    const dangerCard = () => over(t('danger-soft'), page())
    const accentCard = () => over(t('accent-soft'), page())

    it('body text clears AA everywhere it is used', () => {
      for (const [name, bg] of [['page', page()], ['well', well()]] as const) {
        expect(ratio(t('text'), bg), `--text on ${name}`).toBeGreaterThanOrEqual(4.5)
      }
    })

    // The one that was failing on all four surfaces, including the label of the field that confirms
    // deleting a vault.
    it('muted text clears AA on every surface it is placed on', () => {
      for (const [name, bg] of [
        ['page', page()], ['well', well()],
        ['danger card', dangerCard()], ['accent card', accentCard()],
      ] as const) {
        expect(ratio(t('text-muted'), bg), `--text-muted on ${name}`).toBeGreaterThanOrEqual(4.5)
      }
    })

    it('the funds-loss warning clears AA on the danger card it sits on', () => {
      expect(ratio(t('warn-strong'), dangerCard())).toBeGreaterThanOrEqual(4.5)
    })

    // The banner that warns about the vault itself (the open vault on the Dashboard, a coordinator
    // that answers with another address on Receive, A9) sits on the raised surface.
    it('the vault warning banner clears AA on the surface it sits on', () => {
      // Read from the rule that ships, so a change to the banner is what gets measured.
      const decls = appRule('.banner-warn')
      const fg = tokenIn(decls, 'color')
      const bg = tokenIn(decls, 'background')
      expect(fg, '.banner-warn sets its text colour from a token').toBeTruthy()
      expect(bg, '.banner-warn sets its background from a token').toBeTruthy()
      expect(decls, 'a faded banner would pass the token check and not the eye').not.toMatch(/opacity/)
      expect(decls).toMatch(/border:\s*1px solid var\(--warn\)/) // a frame, not colour alone
      expect(ratio(t(fg!), t(bg!))).toBeGreaterThanOrEqual(4.5)
    })

    it('the network pill clears AA on its own wash', () => {
      expect(ratio(t('accent-on-soft'), accentCard())).toBeGreaterThanOrEqual(4.5)
    })

    // The docs read the colour straight from docs.css, so the rule that ships is the rule that is
    // measured. --accent as text measured 4.38:1 on the page and 3.91:1 on the active section's wash.
    it('the docs links, title labels and active section clear AA', () => {
      const activeWash = over(t('accent-soft'), page())
      for (const [selector, bg] of [
        ['.docs-link', page()],
        ['.docs-eyebrow', page()],
        ['.docs-navlink.active', activeWash],
      ] as const) {
        expect(ratio(t(docsTextToken(selector)), bg), selector).toBeGreaterThanOrEqual(4.5)
      }
    })

    // The docs roadmap, read from docs.css the same way: the issue numbers on the well and, hovered, on the
    // accent wash over a step's card; the "now" pill on that wash; the card's title and hint on the card.
    it('the roadmap numbers, pills and card text clear AA', () => {
      const stageCard = t('surface-1')
      const washOnCard = over(t('accent-soft'), stageCard)
      const chip = t(docsTextToken('.docs-ref-chip'))
      for (const [name, fg, bg] of [
        ['number on the well', chip, well()],
        ['number on the wash, hovered', chip, washOnCard],
        ['"now" pill on its wash', t(docsTextToken('.docs-stage[data-status="now"] .docs-stage-status')), washOnCard],
        ['title on the card', t(docsTextToken('.docs-ref-title')), stageCard],
        ['hint on the card', t(docsTextToken('.docs-ref-hint')), stageCard],
      ] as const) {
        expect(ratio(fg, bg), name).toBeGreaterThanOrEqual(4.5)
      }
    })

    // 1.4.11: the edge that says "this is a control". The audit proposed a value for this that
    // reached 1.68, not the 3.05 it claimed - which is the reason this file exists.
    it('a control has a perceptible edge (1.4.11)', () => {
      for (const [name, bg] of [['page', page()], ['well', well()]] as const) {
        expect(ratio(t('line-strong'), bg), `--line-strong on ${name}`).toBeGreaterThanOrEqual(3)
      }
    })

    it('the focus ring is visible against what surrounds it', () => {
      for (const [name, bg] of [
        ['page', page()], ['danger card', dangerCard()], ['accent card', accentCard()],
      ] as const) {
        expect(ratio(t('accent'), bg), `--accent ring on ${name}`).toBeGreaterThanOrEqual(3)
      }
    })
  })
}
