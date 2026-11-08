import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// The vault card's viewing code is compared group by group, out loud: the stylesheet must keep each
// group of five on one line and must not break the code at any character (the measured check is
// e2e/viewing-code-wrap.spec.ts).
describe('the viewing code never splits a group', () => {
  const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  it('a grouped code is not broken at any character', () => {
    expect(css).toMatch(/\.fp-code\.grouped\{[^}]*word-break:normal/)
  })
  it('a group stays on one line', () => {
    expect(css).toMatch(/\.fp-code \.fp-grp\{[^}]*white-space:nowrap/)
  })
})
