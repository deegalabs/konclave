import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'
import { fmtZec, fmtZecExact } from './format'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// Daniel, 2026-11-07. The Dashboard read amounts with `fmtZec`, which rounds to four decimals, so a
// payment of 0.00015 ZEC was listed as 0.0001 among the movements: a figure the vault never paid.
// The Ledger and the Proposal screens read the exact figure since #777; the Dashboard's balance card
// and its movements now do too. `fmtZecExact` keeps four decimals and adds one only where the
// figure has it, so 0.0120 still reads 0.0120 on the balance card.
describe('the Dashboard shows the exact amount', () => {
  const src = codeOf('screens/Dashboard.tsx')

  it('a movement of 0.00015 ZEC shows 0.00015, not 0.0001', () => {
    expect(fmtZec(0.00015), 'the four-decimal reader rounds it away').toBe('0.0001')
    expect(fmtZecExact(15_000 / 1e8)).toBe('0.00015')
    const line = src.split('\n').find((l) => /^\s*value: movement\.out \?/.test(l))
    expect(line, 'the movements no longer build their value here').toBeTruthy()
    expect(line).toMatch(/fmtZecExact\(p\.value_zat \/ 1e8\)/)
    expect(line).not.toMatch(/fmt4\(/)
  })

  it('the balance card reads the exact figure, at four decimals when that is all it has', () => {
    expect(src).toMatch(/const amt = hasBal \? fmtZecExact\(Number\(balance!\.total_zec\)\) : '-'/)
    expect(fmtZecExact(0.012)).toBe('0.0120')
    expect(fmtZecExact(0.01234567)).toBe('0.01234567')
  })

  it('a long balance is shrunk to stay in its card, and so is a long KPI figure (I1)', () => {
    // 0.01234567 has ten characters; at the full size it passes the side column on a desktop. The
    // e2e (dashboard-amounts.spec.ts) measures it on the real screen.
    expect(fmtZecExact(0.01234567).length).toBeGreaterThan(7)
    expect(fmtZecExact(0.012).length).toBeLessThanOrEqual(7)
    expect(src).toMatch(/className=\{'amt' \+ \(amt\.length > 7 \? ' amt-long' : ''\)\}/)
    expect(src).toMatch(/className=\{'kpi-v' \+ \(reservedTxt\.length > 7 \? ' kpi-long' : ''\)\}/)
    expect(src).toMatch(/className=\{'kpi-v' \+ \(paidTxt\.length > 7 \? ' kpi-long' : ''\)\}/)
    const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.amt-long\{font-size:clamp\(30px,4\.6vw,40px\)\}/)
    expect(css).toMatch(/\.kpi-v\.kpi-long\{font-size:14px\}/)
  })

  it('one figure has one precision: nothing on the Dashboard rounds to four decimals (I2)', () => {
    // The total exact and its composition rounded, or the desk rounded and the movements exact, put
    // two readings of one amount on one screen.
    expect(src).not.toMatch(/\bfmt4\(|fmtZec as|\bfmtZec\(/)
    // From zatoshi where the figure has them, so no decimal string goes through floating point.
    expect(src).not.toMatch(/parseZ\(p\.value_zec\)/)
    // The month bars are the Dashboard's too: their tooltip and their table for a screen reader.
    const charts = codeOf('charts.tsx')
    expect(charts).toMatch(/const fmt = fmtZecExact\b/)
    expect(charts).not.toMatch(/maximumFractionDigits/)
  })
})

// NU7 activated at block 3,543,405 and payments after it are proven on mainnet, so the Dashboard no
// longer tells of the upgrade. The rule that decides the window (`upgrade-notice.ts`) and the height
// WASM reads from the epoch table stay for the next upgrade; the screen and its copy go.
describe('the Dashboard no longer shows the network-upgrade notice', () => {
  it('neither renders it nor keeps the state that drove it', () => {
    const src = codeOf('screens/Dashboard.tsx')
    expect(src).not.toMatch(/upgradeNotice|upgradeHeight|upgradeAt/)
    expect(src).not.toMatch(/dashboard\.upgrade(Before|After)/)
  })

  it('the removal names the upgrade by its block, not by a calendar date (M1)', () => {
    // A calendar date for an activation is an estimate from the block time; the height is the fact.
    // Only the changelog fragment is pinned: the code says it in comments, and no test reads source
    // raw (source-scan.test.ts), so a comment cannot satisfy a pin.
    const entry = readFileSync(new URL('../changelog.d/changed/dashboard-upgrade-notice-removed.md', import.meta.url), 'utf8')
    expect(entry).toMatch(/^- \*\*The dashboard no longer shows the network-upgrade notice\.\*\*/)
    expect(entry).toMatch(/block\s+3,543,405/)
    expect(entry).not.toMatch(/2026-11-05|November 2026/)
  })

  it('its copy is gone in both languages', () => {
    for (const d of [en, ptBR] as Record<string, string>[]) {
      expect(d['dashboard.upgradeBefore']).toBeUndefined()
      expect(d['dashboard.upgradeAfter']).toBeUndefined()
    }
  })
})
