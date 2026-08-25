/// <reference types="node" />
// A modal is the most blocking surface on screen, so it must sit above every session surface. This
// is a regression guard for a real money-path failure: the send confirm was declared at z-index 30,
// UNDER the signing sheet (41) and its scrim (40). It rendered buried - it looked greyed out, took
// no click, and the click landed on the scrim beneath it, which closed the panel and discarded the
// state. No error, no request, no send. Nothing in TypeScript could catch that; this can.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Layers are declared across the stylesheets, so read them all: a modal must clear every one.
const css = ['./App.css', './lacre.css', './redesign.css', './net.css']
  .map((f) => { try { return readFileSync(new URL(f, import.meta.url), 'utf8') } catch { return '' } })
  .join('\n')

/** The z-index declared for a selector, from the stylesheet itself. */
function z(selector: string): number {
  const rule = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`, 'g')
  for (const m of css.match(rule) ?? []) {
    const hit = /z-index:\s*(\d+)/.exec(m)
    if (hit) return Number(hit[1])
  }
  throw new Error(`no z-index found for ${selector}`)
}

describe('stacking order: a modal is never buried', () => {
  it('the confirm modal sits above the signing sheet and its scrim', () => {
    expect(z('.modal-overlay')).toBeGreaterThan(z('.sign-sheet'))
    expect(z('.modal-overlay')).toBeGreaterThan(z('.sign-scrim'))
  })

  it('the signing sheet itself sits above its own scrim', () => {
    expect(z('.sign-sheet')).toBeGreaterThan(z('.sign-scrim'))
  })

  it('the confirm modal sits above every other overlay that can be open under it', () => {
    // The vault switcher (and its scrim) and the mobile bottom nav: each one, left above a modal,
    // would take the click meant for the money confirm.
    for (const under of ['.vault-pop', '.vault-scrim', '.railnav', '.nav-more-sheet']) {
      expect(z('.modal-overlay')).toBeGreaterThan(z(under))
    }
  })
})
