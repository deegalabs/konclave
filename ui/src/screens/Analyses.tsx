// Analyses: arithmetic over the vault's book, one reading at a time. Linked from the Ledger only,
// not from the menu, until the menu is reworked.
//
// It adds no number of its own. The balance band is `balanceParts`, the same split the payment
// screen gates on; the pace, the runway and the projection are `treasury-metrics.ts`; the chart is
// `FundsLine`, which follows the chart rule in STYLE.md. Every reading says its limits in the words
// the metrics module states them: month by proposal date, network fee not included, incoming money
// not shown. Below three complete months it says there is not enough history and draws nothing.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getBalance, getLedger, getVault, ledgerReadFailure, type Balance, type Proposal } from '../api'
import { analysesReport, exportAnalyses } from '../analysesReport'
import { balanceParts, freeZatOf, reservedZatOf } from '../balance-parts'
import { FundsLine } from '../charts'
import { RevealButton, Secret } from '../components'
import { fmtZecExact, zatToZec } from '../format'
import { useI18n, type Locale, type TFn } from '../i18n'
import { useLoading } from '../loading'
import { PageFooter, PageHeader } from '../page'
import ReadState from '../ReadState'
import { useReveal } from '../reveal'
import { burnRate, projection, runway } from '../treasury-metrics'
import { startVisiblePoll } from '../usePoll'
import { useVaultReadable } from '../vault-readable'

const zec = (zat: number) => fmtZecExact(Number(zatToZec(zat)))
/** A month as the axis and the warning write it. Short months lose the period some locales add
 *  ("nov."), and January carries its two-digit year, so an axis that crosses a year says so. */
const month = (unix: number, locale: Locale, long = false) => {
  const d = new Date(unix * 1000)
  if (long) return d.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
  const short = d.toLocaleDateString(locale, { month: 'short' }).replace(/\.$/, '')
  return d.getMonth() === 0 ? `${short} ${String(d.getFullYear()).slice(2)}` : short
}

/** The vault's balance in its parts. Nothing is drawn from a balance that was not read. */
export function BalanceBand({ bal, rows, t }: { bal: Balance | null; rows: readonly Proposal[] | null; t: TFn }) {
  if (!bal || bal.total_zat == null) return <p className="hint">{t('analyses.balanceUnread')}</p>
  // The book was not read: the page's ReadState names it, so the band does not blame the balance.
  const reserved = reservedZatOf(rows)
  if (reserved === null) return null
  const parts = balanceParts(bal.total_zat, bal.spendable_zat ?? bal.total_zat, reserved)
  const cell = (label: string, zat: number) => (
    <div className="db-t"><dt className="klab">{label}</dt><dd><Secret sm label={label}><b className="mono">{zec(zat)}</b></Secret></dd></div>
  )
  return (
    <div className="doc-band an-band">
      <div className="db-totals">
        <dl className="an-cells">
          {cell(t('analyses.inVault'), parts.totalZat)}
          {cell(t('analyses.free'), parts.freeZat)}
          {cell(t('analyses.reserved'), parts.reservedZat)}
          {cell(t('analyses.confirming'), parts.confirmingZat)}
        </dl>
        <span className="db-reveal"><RevealButton /></span>
      </div>
    </div>
  )
}

/** Pace, runway and the projection of free funds, or the plain reason they are not shown. */
export function RunwayPanel({ bal, rows, now, revealed, t, locale }: {
  bal: Balance | null
  rows: readonly Proposal[] | null
  now: Date
  revealed: boolean
  t: TFn
  locale: Locale
}) {
  // An unread book is "unknown", not "not enough history": burnRate tells the two apart.
  const burn = burnRate(rows, now)
  if (burn.kind === 'unknown') return <p className="hint">{t('analyses.unknown')}</p>
  if (burn.kind === 'not-enough-history') return <p className="hint">{t('analyses.notEnough')}</p>
  const run = runway(bal, rows, burn)
  const proj = projection(bal, rows, burn, now)
  const free = freeZatOf(bal, rows)
  const runsOut = proj && proj.runsOutIndex !== null ? month(proj.points[proj.runsOutIndex]!.from, locale, true) : null
  return (
    <>
      <dl className="an-figs">
        <div>
          <dt className="klab">{t('analyses.pace')}</dt>
          <dd><Secret sm label={t('analyses.pace')}><b className="mono">{t('analyses.paceValue', { zec: zec(burn.zatPerMonth) })}</b></Secret></dd>
          <dd className="by">{t('analyses.paceHow')}</dd>
        </div>
        <div>
          <dt className="klab">{t('analyses.runway')}</dt>
          <dd>
            <b className="mono">
              {run.kind === 'months'
                ? t('analyses.runwayMonths', { n: (run.tenths / 10).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
                : <><span aria-hidden="true">-</span><span className="visually-hidden">{t('analyses.na')}</span></>}
            </b>
          </dd>
          <dd className="by">
            {run.kind === 'months' ? t('analyses.runwayHow') : run.kind === 'no-spend' ? t('analyses.noSpend') : t('analyses.balanceUnread')}
          </dd>
        </div>
      </dl>
      {burn.undated > 0 && <p className="hint">{t('analyses.undated', { n: burn.undated })}</p>}
      {run.kind === 'months' && proj && free !== null && (revealed
        ? (
          <FundsLine
            now={{ label: month(Math.floor(now.getTime() / 1000), locale), zat: free }}
            ahead={proj.points.map((p) => ({ label: month(p.from, locale), zat: p.balanceZat }))}
            nowLabel={t('analyses.now')}
            projectedLabel={t('analyses.projected')}
            title={t('analyses.chartTitle')}
            source={t('analyses.source')}
            tooShort={t('analyses.notEnough')}
            runsOut={runsOut && proj.runsOutIndex !== null ? { index: proj.runsOutIndex, words: t('analyses.runsOut', { month: runsOut }) } : null}
          />
        )
        : (
          <>
            {runsOut && <p className="chart-warn">{t('analyses.runsOut', { month: runsOut })}</p>}
            <p className="hint">{t('analyses.hiddenChart')}</p>
            <p className="chart-src">{t('analyses.source')}</p>
          </>
        ))}
      {run.kind !== 'months' && <p className="chart-src">{t('analyses.source')}</p>}
    </>
  )
}

export default function Analyses() {
  const { t, locale } = useI18n()
  const { begin, end } = useLoading()
  const readable = useVaultReadable()
  const { revealed } = useReveal()
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [bal, setBal] = useState<Balance | null>(null)
  const [unread, setUnread] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Nothing is said about the balance or the book until the first read answers: before it, both
  // are null, and "could not be read" would report a failure that has not happened.
  const [loaded, setLoaded] = useState(false)
  const [vaultName, setVaultName] = useState<string | null>(null)
  const [exporting, setExporting] = useState<null | 'xlsx' | 'html'>(null)
  const [exportFailed, setExportFailed] = useState(false)

  useEffect(() => {
    // Locked: a 401 would read as an empty book, so nothing is read until the vault is unlocked.
    if (!readable) return
    let on = true
    let inFlight = false
    const load = async (first: boolean) => {
      if (inFlight) return
      inFlight = true
      if (first) begin()
      try {
        const [l, b, v] = await Promise.all([getLedger(), getBalance(), first ? getVault() : Promise.resolve(null)])
        if (!on) return
        if (l) { setRows(l); setUnread(false) } else if (first) setUnread(true)
        if (b) setBal(b)
        if (v) setVaultName(v.name)
      } finally {
        inFlight = false
        if (first) { end(); if (on) setLoaded(true) }
      }
    }
    void load(true)
    const stop = startVisiblePoll(() => void load(false), 30_000)
    return () => { on = false; stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, readable])

  // Both files come from one list of rows (analysesReport), each row saying where its number came
  // from. Built from what this screen has read; nothing to export until the book was read.
  async function exportAs(kind: 'xlsx' | 'html') {
    if (exporting || rows === null) return
    setExporting(kind)
    setExportFailed(false)
    try {
      const report = analysesReport({ bal, rows, vaultName: vaultName ?? 'Konclave', now: new Date(), t, locale })
      if (!(await exportAnalyses(report, kind, locale))) setExportFailed(true)
    } catch {
      setExportFailed(true)
    } finally {
      setExporting(null)
    }
  }
  const actions = (
    <>
      <button className="btn ghost sm-btn" disabled={exporting !== null || rows === null} title={t('analyses.exportHint')} onClick={() => void exportAs('xlsx')}>{exporting === 'xlsx' ? t('analyses.exporting') : t('analyses.exportXlsx')}</button>
      <button className="btn ghost sm-btn" disabled={exporting !== null || rows === null} title={t('analyses.exportHint')} onClick={() => void exportAs('html')}>{exporting === 'html' ? t('analyses.exporting') : t('analyses.exportHtml')}</button>
    </>
  )

  return (
    <main className="page">
      <PageHeader title={t('analyses.title')} subtitle={t('analyses.sub')} back={{ to: '/ledger', label: t('ledger.title') }} actions={actions} />
      <p className="cap">{t('analyses.exportHint')}</p>
      {exportFailed && <p className="hint warn" role="alert">{t('analyses.exportFailed')}</p>}
      {rows === null && unread && (
        <ReadState title={t('ledger.unreadTitle')} failure={ledgerReadFailure()} onRetry={() => setAttempt((a) => a + 1)} />
      )}
      {loaded && <BalanceBand bal={bal} rows={rows} t={t} />}
      <section className="an-sec mt" aria-labelledby="an-runway">
        <h2 className="klab" id="an-runway">{t('analyses.runwayTitle')}</h2>
        {loaded && <RunwayPanel bal={bal} rows={rows} now={new Date()} revealed={revealed} t={t} locale={locale} />}
      </section>
      <PageFooter>
        <span className="dim pushr">{t('analyses.foot')}</span>
        <Link className="link" to="/ledger">{t('ledger.title')}</Link>
      </PageFooter>
    </main>
  )
}
