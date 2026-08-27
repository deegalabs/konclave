// The width system, pinned. The rail sits at the left edge of a CENTRED shell, so anything that
// changes the shell's width per route moves the whole navigation sideways when you navigate.
//
// That is not hypothetical: a per-page `max-width` on `.applayout` (added to give the dashboard
// room, removed again) put the rail at x=0 on /dashboard and x=140 on /ledger, measured on
// production. This test exists so the next attempt to widen one screen fails here instead.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
// Comments are stripped first: they quote selectors (this file's own rationale mentions
// `.applayout`), and a naive block parser would read that prose as a rule.
const all = ['lacre.css', 'App.css'].map(read).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')

/** Declaration blocks, as [selector, body] pairs. */
function rules(): [string, string][] {
  const out: [string, string][] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(all)) !== null) out.push([m[1]!.trim(), m[2]!])
  return out
}

/** Bodies of rules whose selector CONTAINS the fragment. */
function blocks(fragment: string): string[] {
  return rules().filter(([sel]) => sel.includes(fragment)).map(([, body]) => body)
}

/** Bodies of rules targeting the shell ITSELF, not something inside it. */
function shellRules(): string[] {
  return rules()
    .filter(([sel]) => sel.split(',').some((s) => s.trim().startsWith('.applayout')))
    .filter(([sel]) => !/\.applayout\s+\S/.test(sel)) // exclude descendants
    .map(([, body]) => body)
}

describe('the shell is the same width on every route', () => {
  it('sets its max-width exactly once, from the token', () => {
    const caps = shellRules().filter((b) => /max-width/.test(b))
    expect(caps).toHaveLength(1)
    expect(caps[0]).toMatch(/max-width:\s*var\(--shell-w\)/)
  })

  it('never varies the shell by which page is inside it', () => {
    // The regression this pins: `.applayout:has(… .page.dash){max-width:…}`.
    const perPageShell = /\.applayout[^{,]*:has\([^)]*\)[^{]*\{[^}]*max-width/.test(all)
    expect(perPageShell).toBe(false)
  })
})

describe('every screen behind the menu is the same width', () => {
  it('declares the four width tokens once', () => {
    for (const t of ['--shell-w', '--content-w', '--col-read', '--col-narrow']) {
      const declared = all.match(new RegExp(`${t}\\s*:`, 'g')) ?? []
      expect(declared, `${t} should be declared exactly once`).toHaveLength(1)
    }
  })

  it('gives no page its own width', () => {
    // Three page widths (1280 / 940 / 560) meant the app resized as you moved through the menu.
    // A screen that needs a narrower COLUMN constrains its content, not its page.
    for (const [sel] of rules()) {
      if (!/\.page\.[a-z-]+/.test(sel)) continue
      const body = blocks(sel.trim())[0] ?? ''
      const capsThePage = /(^|;|\s)max-width\s*:/.test(body) && !/>\s*\*/.test(sel)
      expect(capsThePage, `${sel.trim()} must not set its own page width`).toBe(false)
    }
  })

  it('caps the page once, from the token, and centres it', () => {
    // Only the rule that CAPS it - the same selector also appears in a media query that adjusts
    // padding, and that one is not a width declaration.
    const page = rules()
      .filter(([sel]) => sel.trim() === '.applayout .page')
      .map(([, body]) => body)
      .filter((b) => /max-width/.test(b))
    expect(page, 'the page width should be declared in exactly one place').toHaveLength(1)
    expect(page[0]).toMatch(/max-width:\s*var\(--content-w\)/)
    expect(page[0]).toMatch(/margin-inline:\s*auto/)
  })
})
