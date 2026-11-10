// The Analyses export: one list of rows, two files. These pin that every number travels with where
// it came from and the limits sentence, that the spreadsheet and the page say the same thing, and
// that the file stays as quiet as the screen when the history or the balance is missing.
import { describe, expect, it } from 'vitest'
import type { Balance, Proposal } from './api'
import { analysesHtml, analysesReport, analysesWorkbook, type AnalysesReport } from './analysesReport'
import { translateStatic, type TFn } from './i18n'
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
const book = [p('confirmed', ZEC, at(2026, 6)), p('sent', ZEC, at(2026, 7)), p('sent', 2 * ZEC, at(2026, 8)), p('confirmed', ZEC, at(2026, 9)), p('rejected', 9 * ZEC, at(2026, 9))]
const report = (o: Partial<Parameters<typeof analysesReport>[0]> = {}) =>
  analysesReport({ bal: bal(5 * ZEC), rows: book, vaultName: 'Caixa <da> comunidade', now: NOW, t, locale: 'en', ...o })
const rowsOf = (r: AnalysesReport) => r.sections.flatMap((s) => s.rows)

describe('analysesReport', () => {
  it('gives every number a source and carries the limits sentence', () => {
    const r = report()
    expect(r.limits).toBe(translateStatic('analyses.source', undefined, 'en'))
    const all = rowsOf(r)
    expect(all.length).toBeGreaterThan(10)
    for (const row of all) expect(row.source.length, row.label).toBeGreaterThan(10)
  })

  it('lists the months the pace is built from, then the pace, the runway and the projection', () => {
    const r = report()
    expect(r.sections.map((s) => s.title)).toEqual(['Balance', 'What left the vault, by month', 'Runway and projection', 'Projection'])
    expect(r.sections[1]!.rows.map((x) => [x.label, x.value])).toEqual([
      ['August 2026', '1.00000000'], ['September 2026', '2.00000000'], ['October 2026', '1.00000000'],
    ])
    expect(r.sections[2]!.rows.map((x) => [x.label, x.value, x.unit])).toEqual([
      ['Pace of spending', '1.33333334', 'ZEC'], ['Runway', '3.7', 'months'],
    ])
    expect(r.sections[3]!.rows[0]!).toMatchObject({ label: 'now (November 2026)', value: '5.00000000' })
    // now, then one point for each of the six months ahead
    expect(r.sections[3]!.rows.map((x) => x.label)).toEqual(['now (November 2026)', 'December 2026', 'January 2027', 'February 2027', 'March 2027', 'April 2027', 'May 2027'])
    expect(r.sections[3]!.rows[1]!.source).toContain('Projected, not recorded')
    expect(r.sections[3]!.note).toBe('At this pace the free funds would run out by March 2027.')
  })

  it('carries no pace, runway or projection below three complete months, and says why', () => {
    const r = report({ rows: [p('sent', ZEC, at(2026, 9))] })
    expect(r.sections.map((s) => s.title)).toEqual(['Balance', 'Runway and projection'])
    expect(r.sections[1]!.rows).toEqual([])
    expect(r.sections[1]!.note).toContain('Not enough history yet')
  })

  it('writes no balance and no runway from a balance it could not read', () => {
    const r = report({ bal: null })
    expect(r.sections[0]!.rows).toEqual([])
    expect(r.sections[0]!.note).toContain('The balance could not be read')
    expect(r.sections[2]!.rows[1]!).toMatchObject({ label: 'Runway', value: '-' })
    expect(r.sections.map((s) => s.title)).not.toContain('Projection')
    // the runway's line is the screen's, not a second "could not be read"
    expect(r.sections[2]!.rows[1]!.source).toBe(t('analyses.runwayAwaitsBalance'))
  })

  it('says nothing is free now, as the screen does, when open proposals hold it all', () => {
    const r = report({ bal: bal(ZEC), rows: [...book, p('ready', 2 * ZEC, at(2026, 10, 5))] })
    expect(r.sections[2]!.rows[1]!).toMatchObject({ label: 'Runway', value: '-', source: t('analyses.noFreeNow') })
    expect(r.sections.map((s) => s.title)).not.toContain('Projection')
  })

  it('writes the balance in its parts, and projects from the free funds, not the total', () => {
    // 5 in the vault, 4 spendable, 1 held by a ready proposal: free 3, held 1, confirming 1
    const r = report({ bal: bal(5 * ZEC, 4 * ZEC), rows: [...book, p('ready', ZEC, at(2026, 10, 1))] })
    expect(r.sections[0]!.rows.map((x) => [x.label, x.value])).toEqual([
      ['In the vault', '5.00000000'], ['Free', '3.00000000'], ['Held by open proposals', '1.00000000'], ['Confirming', '1.00000000'],
    ])
    expect(r.sections[0]!.note).toBeUndefined()
    // 3 free at 1.33333334 a month: 2 whole months and two tenths
    expect(r.sections[2]!.rows[1]!).toMatchObject({ label: 'Runway', value: '2.2' })
    expect(r.sections[3]!.rows[0]!).toMatchObject({ label: 'now (November 2026)', value: '3.00000000' })
  })

  it('says when open proposals hold more than the vault can spend, as the screen does', () => {
    const r = report({ bal: bal(2 * ZEC), rows: [...book, p('awaiting', 3 * ZEC, at(2026, 10, 1))] })
    expect(r.sections[0]!.rows.map((x) => x.value)).toEqual(['2.00000000', '0.00000000', '2.00000000', '0.00000000'])
    expect(r.sections[0]!.note).toBe(t('dashboard.overCommitted'))
    expect(r.sections[0]!.rows[2]!.source).toContain('capped at what can be spent')
  })

  it('names the same cause as the screen when there is no balance, and says when it is the last one kept', () => {
    expect(report({ bal: null, busy: true }).sections[0]!.note).toBe(t('wallet.busyFirst'))
    expect(report({ bal: null, unwired: true }).sections[0]!.note).toBe(t('dashboard.walletNotConnected'))
    expect(report({ bal: null }).sections[0]!.note).toBe(t('analyses.balanceUnread'))
    const kept = report({ busy: true })
    expect(kept.sections[0]!.rows[0]!.value).toBe('5.00000000')
    expect(kept.sections[0]!.note).toBe(t('wallet.busyKept'))
  })

  it('writes one undated payment in the singular', () => {
    const one = report({ rows: [...book, p('sent', ZEC, undefined)] })
    expect(one.sections[1]!.note).toBe(t('analyses.undatedOne', { n: 1 }))
    const two = report({ rows: [...book, p('sent', ZEC, undefined), p('sent', ZEC, undefined)] })
    expect(two.sections[1]!.note).toBe(t('analyses.undated', { n: 2 }))
  })
})

describe('the two files say the same thing', () => {
  it('the page holds every row, the limits and the note, escaped, with no script or outside resource', async () => {
    const r = report()
    const html = analysesHtml(r, 'en')
    for (const row of rowsOf(r)) {
      expect(html).toContain(`<td class="n">${row.value}</td>`)
      expect(html).toContain(row.source.replace(/&/g, '&amp;'))
    }
    expect(html).toContain(r.limits)
    for (const s of r.sections) if (s.note) expect(html).toContain(`<p class="note">${s.note}</p>`)
    expect(html).toContain('would run out by March 2027')
    expect(analysesHtml(report({ rows: [] }), 'en')).toContain('Not enough history yet')
    expect(html).toContain('Caixa &lt;da&gt; comunidade')
    expect(html).not.toContain('<da>')
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//)
  })

  it("the page writes the runway the way the screen does in the reader's language", () => {
    const tp: TFn = (k, v) => translateStatic(k, v, 'pt-BR')
    const html = analysesHtml(report({ t: tp, locale: 'pt-BR' }), 'pt-BR')
    expect(html).toContain('<td class="n">3,7</td>')
    expect(html).not.toContain('<td class="n">3.7</td>')
  })

  it('the spreadsheet holds the same rows, amounts as exact numbers', async () => {
    const r = report()
    const ws = (await analysesWorkbook(r, 'en')).worksheets[0]!
    const cells: unknown[][] = []
    ws.eachRow((row) => cells.push((row.values as unknown[]).slice(1)))
    expect(cells.some((c) => c[0] === r.limits)).toBe(true)
    for (const s of r.sections) if (s.note) expect(cells.some((c) => c[0] === s.note), s.note).toBe(true)
    for (const row of rowsOf(r)) {
      const hit = cells.find((c) => c[0] === row.label && c[3] === row.source)
      expect(hit, row.label).toBeTruthy()
      expect(hit![1]).toBe(/^-?\d+(\.\d+)?$/.test(row.value) ? Number(row.value) : row.value)
    }
    // the runway too is a number, so the spreadsheet writes it the way the reader's locale does
    expect(cells.find((c) => c[0] === 'Runway')![1]).toBe(3.7)
  })
})

it('adds no rule of its own', () => {
  const src = codeOf('analysesReport.ts')
  expect(src).toMatch(/from '\.\/treasury-metrics'/)
  expect(src).toMatch(/from '\.\/balance-parts'/)
  expect(src).not.toMatch(/'sent'|'confirmed'/)
  // the runway's sentence and the long month are the screen's own, from one place each
  expect(src).toMatch(/runwayNoteKey\(run\)/)
  expect(codeOf('screens/Analyses.tsx')).toMatch(/t\(runwayNoteKey\(run\)\)/)
  expect(src).toMatch(/import \{ monthLong \} from '\.\/period'/)
  expect(src).not.toMatch(/month: 'long'|analyses\.balanceUnread'\) \}$/m)
  // the cause of a missing balance too: one choice, which the screen makes as well
  expect(src).toMatch(/balanceNoteKey\(/)
  expect(codeOf('screens/Analyses.tsx')).toMatch(/balanceNoteKey\(/)
  expect(codeOf('screens/Analyses.tsx')).not.toMatch(/'wallet\.busyFirst'|'wallet\.busyKept'/)
})
