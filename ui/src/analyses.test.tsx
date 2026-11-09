// The Analyses screen reads the book; these pin what it may say and when it must stay quiet. It
// adds no number of its own (balanceParts), so the tests are about the words: nothing drawn from a
// balance that was not read, and the right one blamed when something could not be read.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Balance, Proposal } from './api'
import { I18nProvider, translateStatic, type TFn } from './i18n'
import { BalanceBand } from './screens/Analyses'
import { codeOf } from './source-scan'

const ZEC = 100_000_000
const at = (y: number, m: number, d = 15) => Math.floor(new Date(y, m, d).getTime() / 1000)
let n = 0
const p = (state: string, zat: number, created_at: number | undefined): Proposal => ({
  id: `p${n++}`, vault_id: 'v', kind: 'payment', state, proposer: 'ana', value_zat: zat, value_zec: '',
  is_public: false, created_at, approvals: [], refusals: [], approvals_count: 0,
})
const t: TFn = (k, v) => translateStatic(k, v, 'en')
const bal = (zat: number, spendable = zat): Balance => ({ configured: true, total_zat: zat, spendable_zat: spendable })
const wrap = (el: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{el}</I18nProvider>)

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
    expect(src).toMatch(/from '\.\.\/balance-parts'/)
    expect(src).not.toMatch(/'sent'|'confirmed'/)
  })
  it('says nothing about the balance or the book until the first read has answered', () => {
    expect(src).toMatch(/\{loaded && <BalanceBand /)
  })
  it('is reached from the Ledger, not from the menu', () => {
    expect(codeOf('screens/Ledger.tsx')).toContain('to="/analyses"')
    expect(codeOf('Layout.tsx')).not.toContain('/analyses')
  })
})
