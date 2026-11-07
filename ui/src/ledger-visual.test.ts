import { describe, expect, it } from 'vitest'
import { stateGroupOf, SETTLED } from './ledger-state'
import type { Proposal } from './api'
import { codeOf } from './source-scan'

/* The visual pass on the Ledger: less uppercase mono eyebrow, hierarchy by the size of the number,
 * colour only for state (the guide's four groups), breathing room. The guide fixes the grouping
 * once, in product code, and the colours as tokens of the stylesheet, never inside a component. */

const CSS = () => codeOf('App.css')

const p = (state: string, over: Partial<Proposal> = {}): Proposal => ({
  id: 'x', vault_id: 'v', kind: 'payment', state, proposer: 'Ana', value_zat: 1, value_zec: '0', is_public: false,
  approvals: [], refusals: [], approvals_count: 0, ...over,
})
const g = (state: string, over: Partial<Proposal> = {}) => stateGroupOf(p(state, over))

// The stylesheet with every screen-only block taken out (brace-balanced), so what is left is what
// print sees.
function withoutScreenBlocks(css: string): string {
  let out = ''
  let i = 0
  const re = /@media screen[^{]*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    out += css.slice(i, m.index)
    let depth = 1
    let j = m.index + m[0].length
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++ }
    i = j
    re.lastIndex = j
  }
  return out + css.slice(i)
}

describe('one grouping of the states', () => {
  it('needs someone, on its way, settled, closed', () => {
    expect([g('awaiting'), g('ready')]).toEqual(['need', 'need'])
    expect(g('sent')).toBe('way')
    expect(g('confirmed')).toBe('ok')
    expect(['rejected', 'expired', 'cancelled', 'superseded', 'anything'].map((s) => g(s))).toEqual(['closed', 'closed', 'closed', 'closed', 'closed'])
  })
  it('an open proposal past its deadline on this clock is closed, as the desk says, not "needs someone"', () => {
    const past = Math.floor(Date.now() / 1000) - 60
    const future = Math.floor(Date.now() / 1000) + 3600
    expect(g('awaiting', { expiry_unix: past })).toBe('closed')
    expect(g('ready', { expiry_unix: past })).toBe('closed')
    expect(g('awaiting', { expiry_unix: future })).toBe('need')
  })
  it('settled is one rule, shared with the Ledger', () => {
    expect(['sent', 'confirmed', 'awaiting', 'rejected'].map(SETTLED)).toEqual([true, true, false, false])
    const src = codeOf('screens/Ledger.tsx')
    expect(src).not.toMatch(/const SETTLED =/)
    expect(src).toMatch(/import \{[^}]*\bSETTLED\b[^}]*\} from '\.\.\/ledger-state'/)
  })
})

describe('the Ledger wears it', () => {
  const src = codeOf('screens/Ledger.tsx')
  it('the state cell carries its group, from the one function, and no colour of its own', () => {
    expect(src).toMatch(/stateGroupOf\(p\)/)
    expect(src).not.toMatch(/style=\{\{[^}]*color/)
  })
  it('the pass is for the screen only, so the print rules for the book keep the page', () => {
    const css = CSS()
    expect(css).toMatch(/\.ledger-doc \.st-need/)
    expect(withoutScreenBlocks(css)).not.toMatch(/\.ledger-doc/)
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
