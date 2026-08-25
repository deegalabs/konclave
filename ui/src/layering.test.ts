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
    for (const under of ['.vault-pop', '.vault-scrim', '.railnav', '.nav-more-sheet', '.rail']) {
      expect(z('.modal-overlay')).toBeGreaterThan(z(under))
    }
  })
})

describe('stacking order: the shell and the sheets', () => {
  it('the signing sheet covers the rail, not the other way round', () => {
    // The rail is `position:sticky`, which CREATES a stacking context: everything inside it - the
    // vault switcher at z-index 70 included - is trapped at the rail's own level. So the rail needs
    // a level of its own, and every surface meant to cover it needs a higher one.
    expect(z('.sign-sheet')).toBeGreaterThan(z('.rail'))
    expect(z('.sign-scrim')).toBeGreaterThan(z('.rail'))
  })

  it('the vault switcher is reachable: it lives inside the rail, so the rail carries them both', () => {
    // The popover's own z-index is meaningless outside the rail's stacking context; what decides
    // whether it covers the page is the RAIL's level.
    expect(z('.rail')).toBeGreaterThan(z('.railnav')) // above the mobile bar too
    expect(z('.modal-overlay')).toBeGreaterThan(z('.rail'))
  })
})
