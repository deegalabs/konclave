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

describe('pages vary their content width, and only through tokens', () => {
  it('declares the four width tokens once', () => {
    for (const t of ['--shell-w', '--content-w', '--content-wide', '--content-narrow']) {
      const declared = all.match(new RegExp(`${t}\\s*:`, 'g')) ?? []
      expect(declared, `${t} should be declared exactly once`).toHaveLength(1)
    }
  })

  it('gives every page variant a token rather than a literal', () => {
    for (const sel of ['.page.dash', '.page.narrow', '.page.pay']) {
      const b = blocks(sel).filter((x) => /max-width/.test(x))
      expect(b.length, `${sel} should cap its width`).toBeGreaterThan(0)
      expect(b[0], `${sel} should use a token`).toMatch(/max-width:\s*var\(--content-/)
    }
  })

  it('centres the page, so a narrow one does not hug the rail', () => {
    const page = blocks('.applayout .page').filter((b) => /max-width/.test(b))
    expect(page[0]).toMatch(/margin-inline:\s*auto/)
  })
})
