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
const netCss = readFileSync(new URL('./net.css', import.meta.url), 'utf8')

/** The declarations of one rule that starts its line, by its exact selector. */
function ruleIn(source: string, file: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(source)
  if (!m) throw new Error(`no rule for ${selector} in ${file}`)
  return m[1]!
}
/** The declarations of one App.css rule, by its exact selector. */
const appRule = (selector: string) => ruleIn(appCss, 'App.css', selector)
const lruleIn = (selector: string) => ruleIn(css, 'lacre.css', selector)
const netRule = (selector: string) => ruleIn(netCss, 'net.css', selector)
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

    // The notice on a host that is not the official one: text on its own wash, over the card. The
    // fill and edge are decorative (the words carry the warning), but they must exist in BOTH themes:
    // they were undefined, and every use fell back to a light-theme brown that vanished in dark.
    it('the host notice clears AA on its warning wash, and the wash and edge are defined', () => {
      const wash = over(t('warn-soft'), well())
      expect(ratio(t('warn-strong'), wash)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(t('text'), wash)).toBeGreaterThanOrEqual(4.5)
      expect(t('warn-line')).toMatch(/^rgba\(/)
      // Visible against the card in dark too, not just there in the stylesheet.
      expect(ratio(over(t('warn-line'), wash), well())).toBeGreaterThan(1.3)
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
        ['open state on the well', t(docsTextToken('.docs-ref-state[data-state="open"]')), well()],
        ['open state on the wash, hovered', t(docsTextToken('.docs-ref-state[data-state="open"]')), washOnCard],
        ['other state on the well', t(docsTextToken('.docs-ref-state')), well()],
        ['other state on the wash, hovered', t(docsTextToken('.docs-ref-state')), washOnCard],
        ['separator on the well', t(docsTextToken('.docs-ref-sep')), well()],
        ['GitHub date on the card', t(docsTextToken('.docs-ref-asof')), stageCard],
      ] as const) {
        expect(ratio(fg, bg), name).toBeGreaterThanOrEqual(4.5)
      }
    })

    // The roadmap's GitHub state stands out by weight and ink, never by hue: green or purple would say
    // "done", and closed or merged on GitHub is not live. "Open", most of the page, is the quiet one.
    it('the roadmap state uses the neutral inks only, with "open" the quiet one', () => {
      expect(docsTextToken('.docs-ref-state[data-state="open"]')).toBe('text-muted')
      expect(docsTextToken('.docs-ref-state')).toBe('text')
      const rules = [...docsCss.matchAll(/\.docs-ref-state[^{]*\{[^}]*\}/g)].map((m) => m[0])
      expect(rules.length).toBeGreaterThan(0)
      for (const r of rules) expect(r, r).not.toMatch(/success|danger|warn|accent|#[0-9a-f]{3,8}\b|rgb|hsl/i)
      expect(/\.docs-ref-state\[data-state="open"\]\s*\{[^}]*font-weight:\s*400/.test(docsCss)).toBe(true)
      expect(/\.docs-ref-state\s*\{[^}]*font-weight:\s*600/.test(docsCss)).toBe(true)
    })

    // 1.4.11: the edge that says "this is a control". The audit proposed a value for this that
    // reached 1.68, not the 3.05 it claimed - which is the reason this file exists.
    it('a control has a perceptible edge (1.4.11)', () => {
      for (const [name, bg] of [['page', page()], ['well', well()]] as const) {
        expect(ratio(t('line-strong'), bg), `--line-strong on ${name}`).toBeGreaterThanOrEqual(3)
      }
    })

    // The passphrase strength meter (PassphraseField). The label is 11px text on the dialog cards,
    // which start at surface-2 and end at surface-1, so both are measured (the page is not where it
    // renders). Each level paints from a token, never a hex, so a theme change moves it.
    const LEVELS = [['s1', 'danger-text', 'danger'], ['s2', 'warn', 'warn'], ['s3', 'accent-text', 'accent'], ['s4', 'success-text', 'success']] as const
    it('the strength label clears AA on both surfaces of the dialog cards', () => {
      for (const [lvl, text] of LEVELS) {
        const tok = tokenIn(appRule(`.pf-label.${lvl}`), 'color')
        expect(tok, `.pf-label.${lvl} paints from a token`).toBe(text)
        for (const [name, bg] of [['surface-1', t('surface-1')], ['surface-2', t('surface-2')]] as const) {
          expect(ratio(t(tok!), bg), `${lvl} --${tok} on ${name}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })
    it('the strength bars use the matching tokens and clear 3:1 on both surfaces', () => {
      for (const [lvl, , bar] of LEVELS) {
        const tok = tokenIn(appRule(`.pf-bar.on.${lvl}`), 'background')
        expect(tok, `.pf-bar.on.${lvl} paints from a token`).toBe(bar)
        for (const [name, bg] of [['surface-1', t('surface-1')], ['surface-2', t('surface-2')]] as const) {
          expect(ratio(t(tok!), bg), `${lvl} --${tok} on ${name}`).toBeGreaterThanOrEqual(3)
        }
      }
    })
    it('the field label (pf-caption) is muted text that clears AA on the well', () => {
      expect(tokenIn(appRule('.pf-caption'), 'color')).toBe('text-muted')
      expect(ratio(t('text-muted'), t('surface-2'))).toBeGreaterThanOrEqual(4.5)
    })
    // 1.4.11 for the create dialog's field: its edge is --line-strong (1.1 to 1.4:1 with --line).
    // Locked, the fill is surface-2 too, so the edge is what keeps the field visible (3.07 minimum).
    it('the create dialog field has a perceptible edge on both surfaces (1.4.11)', () => {
      expect(netRule('.cv-input')).toMatch(/border:\s*1px solid var\(--line-strong\)/)
      for (const [name, bg] of [['surface-1', t('surface-1')], ['surface-2', t('surface-2')]] as const) {
        expect(ratio(t('line-strong'), bg), `--line-strong on ${name}`).toBeGreaterThanOrEqual(3)
      }
    })

    // Settings' fields (`.input`, about 20 uses): the same edge, read-only included. Read-only keeps
    // the surface-2 fill, so the edge against it (3.07 in dark, the thinnest pair here) is what holds.
    it('the app-wide field edge (.input: Settings and the dialogs), hover and read-only clear 3:1 on both surfaces', () => {
      const input = lruleIn('.input')
      expect(input).toMatch(/border:\s*1px solid var\(--line-strong\)/)
      expect(input).toMatch(/padding:\s*11\.5px 13\.5px/)
      const hover = tokenIn(lruleIn('.input:hover'), 'border-color')
      expect(hover, '.input:hover paints its edge from a token').toBeTruthy()
      const ro = lruleIn('.input[readonly]')
      // The base fill is already surface-2, so a surface-2 fill would change nothing; the lock must
      // show without colour (dashed edge) and without a surface-3 fill (--line-strong is 2.8 there).
      expect(ro).toMatch(/border-style:\s*dashed/)
      expect(tokenIn(ro, 'color')).toBe('text-muted')
      expect(ro).not.toMatch(/surface-3/)
      expect(ro).toMatch(/cursor:\s*default/)
      expect(tokenIn(lruleIn('.input[readonly]:hover'), 'border-color')).toBe('line-strong')
      for (const sel of ['.cv-input[readonly], .net-input[readonly]']) {
        const r = netRule(sel)
        expect(r, sel).toMatch(/border-style:\s*dashed/)
        expect(tokenIn(r, 'color'), sel).toBe('text-muted')
        expect(r).not.toMatch(/surface-3/)
      }
      expect(tokenIn(netRule('.cv-input[readonly]:hover, .net-input[readonly]:hover'), 'border-color')).toBe('line-strong')
      for (const [name, bg] of [['surface-1', t('surface-1')], ['surface-2', t('surface-2')]] as const) {
        expect(ratio(t('line-strong'), bg), `edge on ${name}`).toBeGreaterThanOrEqual(3)
        expect(ratio(t(hover!), bg), `hover --${hover} on ${name}`).toBeGreaterThanOrEqual(3)
      }
    })

    // The text fields that are not `.input` (recipient, amount, payroll line, the
    // create dialog's name and the pairing-code field) must carry the same edge, or one form shows two weights.
    it('every other text field edge is --line-strong, with a --text-muted hover, on both surfaces', () => {
      const edge = (decls: string) => /border(?:-color)?:\s*(?:[\d.]+px solid )?var\(--([a-z-]+)\)/.exec(decls)?.[1]
      const fields: Array<[string, string, string?]> = [
        ['.rcb-field', 'app', '.rcb-field:hover'],
        ['.payamt', 'app', '.payamt:hover'],
        ['.plr-val, .plr-memo', 'app', '.plr-val:hover, .plr-memo:hover'],
        ['.cv-nameinput', 'net', '.cv-nameinput:hover'],
        ['.net-input', 'net', '.net-input:hover'],
      ]
      for (const [sel, file, hov] of fields) {
        const trimmed = sel.trim()
        const decls = file === 'app'
          ? appRule(trimmed)
          : netRule(trimmed)
        expect(edge(decls), `${trimmed} edge`).toBe('line-strong')
        if (file === 'app') expect(decls, `${trimmed} is a 1px edge`).toMatch(/border:\s*1px solid/)
        if (hov) {
          const h = file === 'app' ? appRule(hov) : netRule(hov)
          expect(tokenIn(h, 'border-color'), `${hov}`).toBe('text-muted')
        }
      }
      for (const bg of [t('surface-1'), t('surface-2'), page()]) {
        expect(ratio(t('line-strong'), bg)).toBeGreaterThanOrEqual(3)
        expect(ratio(t('text-muted'), bg)).toBeGreaterThanOrEqual(3)
      }
      // The amount box marks focus the way .input does: a 2px accent outline, not only a faint halo.
      expect(appRule('.payamt:focus-within')).toMatch(/outline:\s*2px solid var\(--accent\)/)
      expect(appRule('.rcb.open .rcb-field, .rcb-field:focus-within')).toMatch(/outline:\s*2px solid var\(--accent\)/)
      expect(appRule('.plr-val:focus, .plr-memo:focus')).toMatch(/outline:\s*2px solid var\(--accent\)/)
      expect(appRule('.plr-val, .plr-memo')).not.toMatch(/outline:\s*none/)
    })

    // #903: in dark the veil's ink was about the colour of the page (1.03 to 1.28:1), so the control
    // that reveals a figure was close to invisible. Its edge is what has to reach 3:1, on every
    // surface a figure sits on, and the rule that ships is what is read.
    it('the veil has a perceptible edge on every surface (1.4.11, #903)', () => {
      expect(lruleIn('.secret .bar')).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--tarja-edge\)/)
      for (const s of ['surface-0', 'surface-1', 'surface-2', 'surface-3']) {
        expect(ratio(t('tarja-edge'), t(s)), `--tarja-edge on ${s}`).toBeGreaterThanOrEqual(3)
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
