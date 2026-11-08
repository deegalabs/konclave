// The Analyses screen reads the book; these pin what it may say and when it must stay quiet. It
// adds no number of its own (treasury-metrics, balanceParts, FundsLine), so the tests are about the
// words: not enough history below three complete months, the three limits always stated, nothing
// drawn from a balance that was not read, and no figure leaking past a hidden amount.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Balance, Proposal } from './api'
import { I18nProvider, translateStatic, type TFn } from './i18n'
import { BalanceBand, RunwayPanel } from './screens/Analyses'
import { codeOf } from './source-scan'

const ZEC = 100_000_000
const at = (y: number, m: number, d = 15) => Math.floor(new Date(y, m, d).getTime() / 1000)
let n = 0
const p = (state: string, zat: number, created_at: number | undefined): Proposal => ({
  id: `p${n++}`, vault_id: 'v', kind: 'payment', state, proposer: 'ana', value_zat: zat, value_zec: '',
  is_public: false, created_at, approvals: [], refusals: [], approvals_count: 0,
})
const NOW = new Date(2026, 10, 10)
const t: TFn = (k, v) => translateStatic(k, v, 'en')
const bal = (zat: number, spendable = zat): Balance => ({ configured: true, total_zat: zat, spendable_zat: spendable })
const wrap = (el: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{el}</I18nProvider>)
const SOURCE = translateStatic('analyses.source', undefined, 'en')

// Three complete months (Aug, Sep, Oct) of 1 ZEC each, the vault first used in July.
const book = [p('confirmed', ZEC, at(2026, 6)), p('sent', ZEC, at(2026, 7)), p('sent', ZEC, at(2026, 8)), p('confirmed', ZEC, at(2026, 9))]

describe('RunwayPanel', () => {
  it('says there is not enough history below three complete months, and draws nothing', () => {
    const html = wrap(<RunwayPanel bal={bal(10 * ZEC)} rows={[p('sent', ZEC, at(2026, 8))]} now={NOW} revealed t={t} locale="en" />)
    expect(html).toContain('Not enough history yet')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('Runway')
  })

  it('shows the pace, the runway and the projection, with the limits under it', () => {
    const html = wrap(<RunwayPanel bal={bal(3 * ZEC + ZEC / 2)} rows={book} now={NOW} revealed t={t} locale="en" />)
    expect(html).toContain('1.0000 ZEC a month')
    expect(html).toContain('3.5 months')
    expect(html).toContain('<svg')
    expect(html).toContain(SOURCE.replace("'", '&#x27;'))
    expect(html).toContain('At this pace the free funds are gone by March 2027.')
  })

  it('subtracts what open proposals hold before it divides', () => {
    const html = wrap(<RunwayPanel bal={bal(3 * ZEC)} rows={[...book, p('awaiting', ZEC, at(2026, 10, 5))]} now={NOW} revealed t={t} locale="en" />)
    expect(html).toContain('2.0 months')
    // and the chart starts from the same free funds, not from the whole balance
    expect(html).toContain('<th scope="row">now (Nov)</th><td>2.0000 ZEC</td>')
  })

  it('says the book was not read, rather than that there is not enough history, when it was not', () => {
    const html = wrap(<RunwayPanel bal={bal(3 * ZEC)} rows={null} now={NOW} revealed t={t} locale="en" />)
    expect(html).toContain('Not shown yet: the book has not been read.')
    expect(html).not.toContain('Not enough history')
    expect(html).not.toContain('<svg')
  })

  it('does not name a runway from a balance it could not read', () => {
    const html = wrap(<RunwayPanel bal={null} rows={book} now={NOW} revealed t={t} locale="en" />)
    expect(html).toContain('1.0000 ZEC a month')
    expect(html).not.toMatch(/\d\.\d months/)
    expect(html).not.toContain('<svg')
    expect(html).toContain('The balance could not be read')
  })

  it('says why there is no runway when nothing left the vault', () => {
    const quiet = [p('sent', ZEC, at(2026, 4)), p('rejected', ZEC, at(2026, 8))]
    const html = wrap(<RunwayPanel bal={bal(ZEC)} rows={quiet} now={NOW} revealed t={t} locale="en" />)
    expect(html).toContain('Nothing left the vault in the last three complete months')
    expect(html).not.toContain('<svg')
    // the missing runway is said, not left as a bare dash for a screen reader
    expect(html).toContain('<span aria-hidden="true">-</span><span class="visually-hidden">Not available</span>')
  })

  it('writes months without a trailing period, and says the year where the axis crosses into one', () => {
    const tp: TFn = (k, v) => translateStatic(k, v, 'pt-BR')
    const html = wrap(<RunwayPanel bal={bal(10 * ZEC)} rows={book} now={NOW} revealed t={tp} locale="pt-BR" />)
    expect(html).toMatch(/>nov<\/span><span style="left:[\d.]+%">dez<\/span><span style="left:[\d.]+%">jan 27<\/span>/)
    expect(html).not.toMatch(/>[a-z]+\.<\/span>/)
  })

  it('draws no projection while amounts are hidden, but still warns and states the limits', () => {
    const html = wrap(<RunwayPanel bal={bal(2 * ZEC)} rows={book} now={NOW} revealed={false} t={t} locale="en" />)
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<table')
    expect(html).toContain('Amounts are hidden')
    expect(html).toContain('are gone by')
    expect(html).toContain('class="chart-src"')
  })

  it('names the outgoing payments it could not date', () => {
    const html = wrap(<RunwayPanel bal={bal(10 * ZEC)} rows={[...book, p('sent', ZEC, undefined)]} now={NOW} revealed t={t} locale="en" />)
    expect(html).toContain('1 outgoing payments have no date')
  })
})

describe('BalanceBand', () => {
  it('splits the balance the way the payment screen does', () => {
    const html = wrap(<BalanceBand bal={bal(5 * ZEC, 4 * ZEC)} rows={[p('ready', ZEC, at(2026, 10, 1))]} t={t} />)
    // in the vault 5, free 3, held 1, confirming 1
    expect(html.match(/<b class="mono">[^<]+<\/b>/g)).toEqual([
      '<b class="mono">5.0000</b>', '<b class="mono">3.0000</b>', '<b class="mono">1.0000</b>', '<b class="mono">1.0000</b>',
    ])
  })

  it('draws no figure from a balance or a book that was not read', () => {
    expect(wrap(<BalanceBand bal={null} rows={[]} t={t} />)).toContain('The balance could not be read')
  })

  it('does not blame the balance when it was the book that could not be read', () => {
    // the page's ReadState names the book; the band stays quiet rather than naming the wrong one
    expect(wrap(<BalanceBand bal={bal(ZEC)} rows={null} t={t} />)).toBe('')
  })

  it('ties each label to its amount, as a list of terms and values', () => {
    const html = wrap(<BalanceBand bal={bal(5 * ZEC, 4 * ZEC)} rows={[]} t={t} />)
    expect(html).toContain('<dl class="an-cells">')
    expect(html).toMatch(/<div class="db-t"><dt class="klab">In the vault<\/dt><dd>/)
  })
})

describe('the screen', () => {
  const src = codeOf('screens/Analyses.tsx')
  it('takes its numbers from the shared modules, not a rule of its own', () => {
    expect(src).toMatch(/from '\.\.\/treasury-metrics'/)
    expect(src).toMatch(/from '\.\.\/balance-parts'/)
    expect(src).not.toMatch(/'sent'|'confirmed'/)
  })
  it('says nothing about the balance or the book until the first read has answered', () => {
    expect(src).toMatch(/\{loaded && <BalanceBand /)
    expect(src).toMatch(/\{loaded && <RunwayPanel /)
  })
  it('is reached from the Ledger, not from the menu', () => {
    expect(codeOf('screens/Ledger.tsx')).toContain('to="/analyses"')
    expect(codeOf('Layout.tsx')).not.toContain('/analyses')
  })
})
