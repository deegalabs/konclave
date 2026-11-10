// Restrained in-app charts. The brand is an "instrument, not a dashboard" (STYLE.md: Variance 2,
// Motion 2, the tarja is the one ornament), so these are matte and unanimated, and use text/silver
// ink for the marks. The rule they follow is STYLE.md "Charts (treasury)": at most two series, never
// told apart by hue (a second cue, not the tone, tells them apart); what is recorded solid and what
// is projected dashed; the accent on the hovered point only; a projection below zero in --warn,
// never --danger, and named in words; every chart with its figures as text, a button that shows them
// to a keyboard or a phone (a native tooltip never shows on focus or touch) and, where a screen gives
// one, a caption saying where they came from.
import { useId, useState } from 'react'
import { fundsGeometry } from './chart-geometry'
import { fmtZatExact, fmtZecExact } from './format'
import { useI18n } from './i18n'

/** A figure as the rest of the screen writes it: at least four decimals, every zatoshi kept. */
const zec = (zat: number) => `${fmtZatExact(zat)} ZEC`

/** The button that shows a chart's table, and the table, hidden in a block until it is shown (a
 *  table ignores the 1px width of .visually-hidden and would widen the page on a phone). */
function Figures({ caption, captionId, rows }: { caption: string; captionId?: string; rows: [string, string][] }) {
  const { t } = useI18n()
  const [shown, setShown] = useState(false)
  const id = `${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-figs`
  return (
    <>
      <button type="button" className="btn ghost sm-btn chart-figs-btn" aria-expanded={shown} aria-controls={id} onClick={() => setShown((v) => !v)}>
        {shown ? t('chart.hideFigures') : t('chart.showFigures')}
      </button>
      <div id={id} className={shown ? 'chart-figs' : 'visually-hidden'}>
        <table>
          <caption id={captionId}>{caption}</caption>
          <tbody>
            {rows.map(([k, v], i) => <tr key={i}><th scope="row">{k}</th><td>{v}</td></tr>)}
          </tbody>
        </table>
      </div>
    </>
  )
}

export interface SpendPoint {
  label: string // period label, e.g. "abr" / "Apr" or "04/26"
  zec: number // settled outflow in that period
  title?: string // full tooltip text (period + amount)
}

/**
 * A compact settled-spend bar strip. Single series (outflow), so no legend (the caption names it).
 * Marks per dataviz: thin bars, 4px rounded tops, a 2px surface gap between bars, the tallest bar
 * darkened, a native per-bar tooltip for the mouse. Renders nothing below two periods (no fake trend
 * on thin data). The strip is hidden from a screen reader, which reads the table; the table is also
 * what "Show figures" opens.
 */
export function SpendBars({ data, unit = 'ZEC', height = 52, source }: { data: SpendPoint[]; unit?: string; height?: number; source?: string }) {
  const { t } = useI18n()
  if (!data || data.length < 2) return null
  const max = Math.max(...data.map((d) => d.zec), 0)
  // data has >= 2 items here (guarded above), so reduce with no initial is safe and stays typed
  // as SpendPoint (never undefined) - unlike passing data[0] under noUncheckedIndexedAccess.
  const peak = data.reduce((a, b) => (b.zec > a.zec ? b : a))
  // Exact, as every other figure on the Dashboard: a month that paid 0.00015 says 0.00015.
  const fmt = fmtZecExact

  return (
    <div className="spend" role="group" aria-label={`${t('dashboard.spendByMonth')} (${unit})`}>
      <div className="spend-bars" style={{ minHeight: height }} aria-hidden="true">
        {data.map((d, i) => {
          const h = max > 0 ? Math.max(2, Math.round((d.zec / max) * height)) : 2
          const isPeak = d === peak && d.zec > 0
          return (
            <div className="spend-col" key={i} title={d.title ?? `${d.label}: ${fmt(d.zec)} ${unit}`}>
              <span className={'spend-bar' + (isPeak ? ' peak' : '')} style={{ height: h }} />
              <span className="spend-lab mono">{d.label}</span>
            </div>
          )
        })}
      </div>
      <Figures caption={t('dashboard.spendByMonth')} rows={data.map((d): [string, string] => [d.label, `${fmt(d.zec)} ${unit}`])} />
      {source && <p className="chart-src">{source}</p>}
    </div>
  )
}

export interface FundsPoint {
  label: string // the month it falls in, e.g. "dez"
  zat: number // free funds at that point, whole zatoshi; negative once a projection runs out
}

/**
 * Free funds now and, if the pace holds, in the months ahead. One series. The first point is the
 * vault's book (solid); every point after it is arithmetic over the book, so the line is dashed, its
 * points hollow, and it is labelled as projected where it ends.
 *
 * Whether it runs out is not decided here: `runsOut` carries `projection()`'s `runsOutIndex` (counted
 * in `ahead`) together with the sentence that names it, so a warn line always has its words. From
 * that month on the points, and the line below zero, are --warn. Without a projected point it says
 * `tooShort`. It draws nothing from an amount that is not a whole number of zatoshi, from a runs-out
 * month that is not on the line, or without a source.
 */
export function FundsLine({
  now,
  ahead,
  nowLabel,
  projectedLabel,
  title,
  source,
  tooShort,
  runsOut,
  height = 120,
}: {
  now: FundsPoint
  ahead: FundsPoint[]
  nowLabel: string
  projectedLabel: string
  title: string
  source: string
  tooShort: string
  runsOut: { index: number; words: string } | null
  height?: number
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const all = [now, ...(ahead ?? [])]
  if (!source.trim() || !all.every((p) => Number.isSafeInteger(p.zat))) return null
  if (all.length < 2) return <p className="hint">{tooShort}</p>
  if (runsOut && !(Number.isInteger(runsOut.index) && runsOut.index >= 0 && runsOut.index < ahead.length)) return null
  // The first warn point, counted in `all` (the recorded point is index 0).
  const warnFrom = runsOut ? runsOut.index + 1 : null
  // The line stretches to the width it is given and keeps a fixed height, so a phone does not
  // flatten it; the points are positioned over it in percent, so stretching never turns them into
  // ellipses.
  const W = 1000
  const g = fundsGeometry(all.map((p) => p.zat), W, height)
  const line = g.xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`

  return (
    <figure className="chart" aria-labelledby={`${id}-t`}>
      {/* The drawing is hidden from a screen reader, which reads the same figures from the table. */}
      <div className="funds-plot" style={{ height }} aria-hidden="true">
        <svg className="funds-svg" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none">
          <defs>
            <clipPath id={`${id}-up`}><rect x="0" y="0" width={W} height={g.zeroY} /></clipPath>
            <clipPath id={`${id}-dn`}><rect x="0" y={g.zeroY} width={W} height={height - g.zeroY} /></clipPath>
          </defs>
          <line className="funds-zero" x1="0" x2={W} y1={g.zeroY} y2={g.zeroY} />
          <path className="funds-proj" d={line} clipPath={`url(#${id}-up)`} />
          {warnFrom !== null && <path className="funds-proj below" d={line} clipPath={`url(#${id}-dn)`} />}
        </svg>
        <span className="funds-zero-lab mono" style={{ top: pct(g.zeroY, height) }}>0</span>
        {g.xy.map((p, i) => {
          const pt = all[i]!
          return (
            <span
              key={i}
              className={'funds-pt' + (i === 0 ? ' rec' : '') + (warnFrom !== null && i >= warnFrom ? ' below' : '')}
              style={{ left: pct(p.x, W), top: pct(p.y, height) }}
              title={`${i === 0 ? nowLabel : projectedLabel} (${pt.label}): ${zec(pt.zat)}`}
            />
          )
        })}
      </div>
      <div className="funds-axis mono" aria-hidden="true">
        {all.map((p, i) => <span key={i} style={{ left: pct(g.xy[i]!.x, W) }}>{p.label}</span>)}
      </div>
      <div className="funds-tags mono" aria-hidden="true">
        <span>{nowLabel} {zec(now.zat)}</span>
        <span>{projectedLabel} {zec(all[all.length - 1]!.zat)}</span>
      </div>
      {runsOut && <p className="chart-warn">{runsOut.words}</p>}
      <Figures
        caption={title}
        captionId={`${id}-t`}
        rows={[[`${nowLabel} (${now.label})`, zec(now.zat)], ...ahead.map((p): [string, string] => [`${projectedLabel} (${p.label})`, zec(p.zat)])]}
      />
      <figcaption className="chart-src">{source}</figcaption>
    </figure>
  )
}
