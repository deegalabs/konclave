import { describe, expect, it } from 'vitest'
import { stateGroupOf } from './ledger-state'
import { codeOf } from './source-scan'

/* The visual pass on the Ledger: less uppercase mono eyebrow, hierarchy by the size of the number,
 * colour only for state (the guide's four groups), breathing room. The guide fixes the grouping
 * once, in product code, and the colours as tokens of the stylesheet, never inside a component. */

const CSS = () => codeOf('App.css')

describe('one grouping of the states', () => {
  it('needs someone, on its way, settled, closed', () => {
    expect(['awaiting', 'ready'].map(stateGroupOf)).toEqual(['need', 'need'])
    expect(stateGroupOf('sent')).toBe('way')
    expect(stateGroupOf('confirmed')).toBe('ok')
    expect(['rejected', 'expired', 'cancelled', 'superseded', 'anything'].map(stateGroupOf)).toEqual(['closed', 'closed', 'closed', 'closed', 'closed'])
  })
})

describe('the Ledger wears it', () => {
  const src = codeOf('screens/Ledger.tsx')
  it('the state cell carries its group, from the one function, and no colour of its own', () => {
    expect(src).toMatch(/stateGroupOf\(p\.state\)/)
    expect(src).not.toMatch(/style=\{\{[^}]*color/)
  })
  it('the body is scoped, so the pass touches the Ledger only', () => {
    expect(src).toMatch(/className="ledger-doc"/)
  })
  it('the stylesheet defines the four group colours under that scope, as tokens', () => {
    const css = CSS()
    for (const g of ['need', 'way', 'ok', 'closed']) {
      const m = new RegExp(`\\.ledger-doc \\.st-${g}\\{color:var\\(--[a-z-]+\\)`).exec(css)
      expect(m, g).not.toBeNull()
    }
    // the band's figure is larger than its label, and the table head is no longer mono uppercase
    expect(css).toMatch(/\.ledger-doc \.db-t b\{[^}]*font-size:2[0-9]px/)
    expect(css).toMatch(/\.ledger-doc \.tbl th\{[^}]*text-transform:none/)
    // the text-tier tokens exist in both themes, so the state words clear 4.5:1 on every surface
    const tokens = codeOf('lacre.css')
    expect(tokens.match(/--success-text:/g)?.length).toBe(2)
    expect(tokens.match(/--accent-text:/g)?.length).toBe(2)
  })
})
