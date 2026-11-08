import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Settings has no section index any more (the v0.19 plan): its layout rules go with it, so no
// stylesheet keeps a two-column grid for a page that no longer has a second column.
const css = readFileSync(fileURLToPath(new URL('./App.css', import.meta.url)), 'utf8')

describe('the index is gone from the stylesheet', () => {
  it('no .set-index rule, and no page grid keyed on it', () => {
    expect(css).not.toMatch(/\.set-index/)
  })
  it('the trust table still scrolls sideways on a narrow screen', () => {
    expect(css).toMatch(/\.trust-wrap\{[^}]*overflow-x:auto/)
  })
})
