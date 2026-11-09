// The Analyses screen reads the book; these pin what it may say and when it must stay quiet. It
// adds no number of its own (balanceParts), so the tests are about the words: nothing drawn from a
// balance that was not read, and the right cause named when something could not be read.
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
const say = (k: string) => translateStatic(k, undefined, 'en')
const bal = (zat: number, spendable = zat): Balance => ({ configured: true, total_zat: zat, spendable_zat: spendable })
const wrap = (el: React.ReactElement) => renderToStaticMarkup(<I18nProvider>{el}</I18nProvider>)

describe('BalanceBand', () => {
  it('splits the balance the way the payment screen does, each figure with its unit', () => {
    const html = wrap(<BalanceBand bal={bal(5 * ZEC, 4 * ZEC)} rows={[p('ready', ZEC, at(2026, 10, 1))]} t={t} />)
    // in the vault 5, free 3, held 1, confirming 1
    expect(html.match(/<b class="mono">[^<]+<\/b>/g)).toEqual([
      '<b class="mono">5.0000 ZEC</b>', '<b class="mono">3.0000 ZEC</b>', '<b class="mono">1.0000 ZEC</b>', '<b class="mono">1.0000 ZEC</b>',
    ])
    expect(html).not.toContain(say('dashboard.overCommitted'))
  })

  it('warns when open proposals hold more than the vault can spend', () => {
    // 2 spendable, 3 held: the held cell is capped at 2 and free is 0, so the cap must be said
    const html = wrap(<BalanceBand bal={bal(2 * ZEC)} rows={[p('awaiting', 3 * ZEC, at(2026, 10, 1))]} t={t} />)
    expect(html).toContain('<b class="mono">0.0000 ZEC</b>')
    expect(html).toContain(say('dashboard.overCommitted'))
  })

  it('draws no figure from a balance that was not read', () => {
    expect(wrap(<BalanceBand bal={null} rows={[]} t={t} />)).toContain(say('analyses.balanceUnread'))
  })

  it('says the vault is busy, not that the balance could not be read, during a send', () => {
    const first = wrap(<BalanceBand bal={null} busy rows={[]} t={t} />)
    expect(first).toContain(say('wallet.busyFirst'))
    expect(first).not.toContain(say('analyses.balanceUnread'))
    // with a balance already read, it stays and the band says it is the last one
    const kept = wrap(<BalanceBand bal={bal(ZEC)} busy rows={[]} t={t} />)
    expect(kept).toContain('<b class="mono">1.0000 ZEC</b>')
    expect(kept).toContain(say('wallet.busyKept'))
  })

  it('says no wallet is connected when the vault reports none', () => {
    const html = wrap(<BalanceBand bal={null} unwired rows={[]} t={t} />)
    expect(html).toContain(say('dashboard.walletNotConnected'))
    expect(html).not.toContain(say('analyses.balanceUnread'))
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
    expect(src).toMatch(/nextBalanceView/)
    // The read that names a busy vault, and the line that names a missing wallet.
    expect(src).toMatch(/readBalance\(\)/)
    expect(src).not.toMatch(/getBalance/)
    expect(src).toMatch(/setUnwired\(!b\.configured\)/)
    expect(src).not.toMatch(/'sent'|'confirmed'/)
  })
  it('says nothing about the balance or the book until the first read has answered', () => {
    expect(src).toMatch(/\{loaded && <BalanceBand /)
  })
  it('has its route, and is reached from the Ledger, not from the menu', () => {
    expect(codeOf('App.tsx')).toMatch(/<Route path="\/analyses" element=\{<Analyses \/>\} \/>/)
    expect(codeOf('screens/Ledger.tsx')).toContain('to="/analyses"')
    expect(codeOf('Layout.tsx')).not.toContain('/analyses')
  })
})
