import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// #662: focus moves to the main heading on every route change, so every routed screen must have one
// the effect can reach: a <PageHeader> (which renders the h1) or an <h1> of its own. Read from
// App.tsx's route table, so a screen added later is checked without anyone remembering this file.
describe('every routed screen has a heading the route focus can reach (#662)', () => {
  const app = codeOf('App.tsx')
  const elements = Array.from(app.matchAll(/<Route [^>]*element=\{<([A-Z]\w*)/g), (m) => m[1]!)
  const screens = Array.from(new Set(elements)).filter((n) => n !== 'Navigate' && n !== 'Layout')
  it('reads the route table', () => {
    expect(screens).toContain('Dashboard')
    expect(screens.length).toBeGreaterThan(15)
  })
  for (const name of screens) {
    it(`${name} renders a heading`, () => {
      const src = codeOf(`screens/${name}.tsx`)
      expect(/<PageHeader\b/.test(src) || /<h1\b/.test(src), `${name}.tsx has neither <PageHeader> nor <h1>`).toBe(true)
    })
  }
})
