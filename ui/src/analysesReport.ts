// The Analyses screen's figures, as a file to hand on: a spreadsheet and a web page, built from ONE
// list of rows so the two can never say different things. Every row carries where its number came
// from, and both files carry the same sentence about the limits as the screen does (STYLE.md,
// "Charts (treasury)"). A PDF is the web page printed by the browser: no new dependency.
//
// It adds no rule of its own. The balance is `balanceParts`; the months, the pace, the runway and
// the projection are `treasury-metrics`. Below three complete months the file says there is not
// enough history and carries no pace, no runway and no projection, as the screen does.
import type { Workbook } from 'exceljs'
import type { Balance, Proposal } from './api'
import { balanceParts, freeZatOf, reservedZatOf } from './balance-parts'
import { downloadBlob } from './download'
import { zatToZec } from './format'
import type { Locale, TFn } from './i18n'
import { BURN_MONTHS, burnRate, monthlyOutflows, projection, runway } from './treasury-metrics'

export type ReportRow = { label: string; value: string; unit: string; source: string }
export type ReportSection = { title: string; rows: ReportRow[]; note?: string }
export type AnalysesReport = {
  vaultName: string
  generatedAt: Date
  limits: string
  sections: ReportSection[]
  labels: { title: string; vault: string; generated: string; figure: string; value: string; unit: string; source: string }
}

const longMonth = (unix: number, locale: Locale) => new Date(unix * 1000).toLocaleDateString(locale, { month: 'long', year: 'numeric' })

export function analysesReport(input: {
  bal: Balance | null
  rows: readonly Proposal[]
  vaultName: string
  now: Date
  t: TFn
  locale: Locale
}): AnalysesReport {
  const { bal, rows, now, t, locale } = input
  const zec = (zat: number, label: string, source: string): ReportRow => ({ label, value: zatToZec(zat), unit: 'ZEC', source })
  const sections: ReportSection[] = []

  const reserved = reservedZatOf(rows)
  if (bal && bal.total_zat != null && reserved !== null) {
    const p = balanceParts(bal.total_zat, bal.spendable_zat ?? bal.total_zat, reserved)
    sections.push({ title: t('analyses.secBalance'), rows: [
      zec(p.totalZat, t('analyses.inVault'), t('analyses.srcInVault')),
      zec(p.freeZat, t('analyses.free'), t('analyses.srcFree')),
      zec(p.reservedZat, t('analyses.reserved'), t('analyses.srcReserved')),
      zec(p.confirmingZat, t('analyses.confirming'), t('analyses.srcConfirming')),
    ] })
  } else {
    sections.push({ title: t('analyses.secBalance'), rows: [], note: t('analyses.balanceUnread') })
  }

  const burn = burnRate(rows, now)
  const pace = t('analyses.runwayTitle')
  if (burn.kind !== 'rate') {
    sections.push({ title: pace, rows: [], note: burn.kind === 'unknown' ? t('analyses.unknown') : t('analyses.notEnough') })
  } else {
    const months = monthlyOutflows(rows, now, BURN_MONTHS).months
    sections.push({
      title: t('analyses.secMonths'),
      rows: months.map((m) => zec(m.outZat, longMonth(m.from, locale), t('analyses.srcMonth'))),
      note: burn.undated > 0 ? t('analyses.undated', { n: burn.undated }) : undefined,
    })
    const run = runway(bal, rows, burn)
    const runRow: ReportRow = run.kind === 'months'
      ? { label: t('analyses.runway'), value: (run.tenths / 10).toFixed(1), unit: t('analyses.unitMonths'), source: t('analyses.runwayHow') }
      : { label: t('analyses.runway'), value: '-', unit: '', source: run.kind === 'no-spend' ? t('analyses.noSpend') : t('analyses.balanceUnread') }
    sections.push({ title: pace, rows: [zec(burn.zatPerMonth, t('analyses.pace'), t('analyses.paceHow')), runRow] })
    const proj = run.kind === 'months' ? projection(bal, rows, burn, now) : null
    const free = freeZatOf(bal, rows)
    if (proj && free !== null) {
      sections.push({
        title: t('analyses.secProjection'),
        rows: [
          zec(free, `${t('analyses.now')} (${longMonth(Math.floor(now.getTime() / 1000), locale)})`, t('analyses.srcFree')),
          ...proj.points.map((pt) => zec(pt.balanceZat, longMonth(pt.from, locale), t('analyses.srcProjected'))),
        ],
        note: proj.runsOutIndex !== null ? t('analyses.runsOut', { month: longMonth(proj.points[proj.runsOutIndex]!.from, locale) }) : undefined,
      })
    }
  }

  return {
    vaultName: input.vaultName,
    generatedAt: now,
    limits: t('analyses.source'),
    sections,
    labels: {
      title: t('analyses.title'), vault: t('ledger.vault'), generated: t('ledger.xlsxGenerated'),
      figure: t('analyses.colFigure'), value: t('analyses.colValue'), unit: t('analyses.colUnit'), source: t('analyses.colSource'),
    },
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A standalone page: no script, no outside resource, readable offline and printable to PDF. */
export function analysesHtml(r: AnalysesReport, locale: Locale): string {
  const L = r.labels
  const table = (s: ReportSection) => [
    `<h2>${esc(s.title)}</h2>`,
    s.rows.length
      ? `<table><colgroup><col style="width:30%"><col style="width:16%"><col style="width:9%"><col></colgroup><thead><tr><th>${esc(L.figure)}</th><th class="n">${esc(L.value)}</th><th>${esc(L.unit)}</th><th>${esc(L.source)}</th></tr></thead><tbody>` +
        s.rows.map((x) => `<tr><td>${esc(x.label)}</td><td class="n">${esc(x.value)}</td><td>${esc(x.unit)}</td><td class="src">${esc(x.source)}</td></tr>`).join('') +
        '</tbody></table>'
      : '',
    s.note ? `<p class="note">${esc(s.note)}</p>` : '',
  ].join('')
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(L.title)} · ${esc(r.vaultName)}</title>` +
    '<style>body{font:14px/1.5 system-ui,sans-serif;color:#15171c;background:#fff;max-width:860px;margin:32px auto;padding:0 16px}' +
    'h1{font-size:22px;margin:0 0 4px}h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin:28px 0 8px;border-bottom:1px solid #d8dbe2;padding-bottom:6px}' +
    '.meta,.limits,.src,.note{color:#4a5060}.limits{margin:12px 0 0}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eceef2;vertical-align:top}' +
    'th{font-size:12px;color:#4a5060}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.src{font-size:12.5px}.note{margin:8px 0 0}</style></head><body>' +
    `<h1>${esc(L.title)}</h1><p class="meta">${esc(L.vault)}: ${esc(r.vaultName)} · ${esc(L.generated)}: ${esc(r.generatedAt.toLocaleString(locale))}</p>` +
    `<p class="limits">${esc(r.limits)}</p>` + r.sections.map(table).join('') + '</body></html>'
}

/** The same rows as a workbook: one sheet, a heading, the limits, then each section's table. */
export async function analysesWorkbook(r: AnalysesReport, locale: Locale): Promise<Workbook> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.created = r.generatedAt
  wb.modified = r.generatedAt
  const L = r.labels
  const ws = wb.addWorksheet(L.title.slice(0, 31))
  ws.columns = [{ width: 34 }, { width: 18 }, { width: 10 }, { width: 70 }]
  ws.addRow([L.title]).font = { bold: true, size: 14 }
  ws.addRow([`${L.vault}: ${r.vaultName}`])
  ws.addRow([`${L.generated}: ${r.generatedAt.toLocaleString(locale)}`])
  ws.addRow([r.limits]).font = { italic: true }
  for (const s of r.sections) {
    ws.addRow([])
    ws.addRow([s.title]).font = { bold: true }
    if (s.rows.length) {
      ws.addRow([L.figure, L.value, L.unit, L.source]).font = { bold: true }
      for (const x of s.rows) {
        const row = ws.addRow([x.label, x.unit === 'ZEC' ? Number(x.value) : x.value, x.unit, x.source])
        if (x.unit === 'ZEC') row.getCell(2).numFmt = '0.00000000'
        row.getCell(2).alignment = { horizontal: 'right' }
      }
    }
    if (s.note) ws.addRow([s.note]).font = { italic: true }
  }
  return wb
}

const fileBase = (r: AnalysesReport) => `konclave-${r.vaultName.replace(/[^\w-]+/g, '-').toLowerCase() || 'vault'}-analyses`

export async function exportAnalyses(r: AnalysesReport, kind: 'xlsx' | 'html', locale: Locale): Promise<boolean> {
  if (kind === 'html') return downloadBlob(`${fileBase(r)}.html`, new Blob([analysesHtml(r, locale)], { type: 'text/html' }))
  const buf = await (await analysesWorkbook(r, locale)).xlsx.writeBuffer()
  return downloadBlob(`${fileBase(r)}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
}
