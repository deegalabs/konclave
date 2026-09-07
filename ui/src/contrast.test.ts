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

    it('the network pill clears AA on its own wash', () => {
      expect(ratio(t('accent-on-soft'), accentCard())).toBeGreaterThanOrEqual(4.5)
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
