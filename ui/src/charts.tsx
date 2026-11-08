// Restrained in-app charts. The brand is an "instrument, not a dashboard" (STYLE.md: Variance 2,
// Motion 2, the tarja is the one ornament), so these are matte and unanimated, and use text/silver
// ink for the marks. The rule they follow is STYLE.md "Charts (treasury)": at most two series, never
// told apart by hue (a second cue, not the tone, tells them apart); what is recorded solid and what
// is projected dashed; the accent on the hovered point only; a projection below zero in --warn,
// never --danger; every chart with its figures as text and, where a screen gives one, a caption
// saying where they came from.
import { useId } from 'react'
import { fundsGeometry } from './chart-geometry'
import { fmtZecExact, zatToZec } from './format'

export interface SpendPoint {
  label: string // period label, e.g. "abr" / "Apr" or "04/26"
  zec: number // settled outflow in that period
  title?: string // full tooltip text (period + amount)
}

/**
 * A compact settled-spend bar strip. Single series (outflow), so no legend (the caption names it).
 * Marks per dataviz: thin bars, 4px rounded tops, a 2px surface gap between bars, the tallest bar
 * direct-labeled, a native per-bar tooltip. Renders nothing below two periods (no fake trend on
 * thin data). Accessible: labelled group + an offscreen table fallback.
 */
export function SpendBars({ data, unit = 'ZEC', height = 52, source }: { data: SpendPoint[]; unit?: string; height?: number; source?: string }) {
  if (!data || data.length < 2) return null
  const max = Math.max(...data.map((d) => d.zec), 0)
  // data has >= 2 items here (guarded above), so reduce with no initial is safe and stays typed
  // as SpendPoint (never undefined) - unlike passing data[0] under noUncheckedIndexedAccess.
  const peak = data.reduce((a, b) => (b.zec > a.zec ? b : a))
  // Exact, as every other figure on the Dashboard: a month that paid 0.00015 says 0.00015.
  const fmt = fmtZecExact

  return (
    <div className="spend" role="group" aria-label={`Spend by period (${unit})`}>
      <div className="spend-bars" style={{ minHeight: height }}>
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
      {/* Offscreen table fallback - identity/value never color-alone. */}
      <table className="visually-hidden">
        <caption>Spend by period</caption>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}><th scope="row">{d.label}</th><td>{fmt(d.zec)} {unit}</td></tr>
          ))}
        </tbody>
      </table>
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
 * points hollow, and it is labelled as projected where it ends. The part at or below the zero line is
 * --warn, and `runsOut` names it in words. Renders nothing without at least one projected point.
 */
export function FundsLine({
  now,
  ahead,
  nowLabel,
  projectedLabel,
  title,
  source,
  runsOut,
  height = 120,
}: {
  now: FundsPoint
  ahead: FundsPoint[]
  nowLabel: string
  projectedLabel: string
  title: string
  source: string
  runsOut?: string
  height?: number
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  if (!ahead || ahead.length < 1) return null
  const all = [now, ...ahead]
  // The line stretches to the width it is given and keeps a fixed height, so a phone does not
  // flatten it; the points are positioned over it in percent, so stretching never turns them into
  // ellipses.
  const W = 1000
  const g = fundsGeometry(all.map((p) => p.zat), W, height)
  const first = g.xy[0]!
  const last = g.xy[g.xy.length - 1]!
  const line = g.xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`

  return (
    <figure className="chart">
      <div className="funds-plot" style={{ height }} role="img" aria-label={title}>
        <svg className="funds-svg" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={`${id}-up`}><rect x="0" y="0" width={W} height={g.zeroY} /></clipPath>
            <clipPath id={`${id}-dn`}><rect x="0" y={g.zeroY} width={W} height={height - g.zeroY} /></clipPath>
          </defs>
          <line className="funds-zero" x1="0" x2={W} y1={g.zeroY} y2={g.zeroY} />
          <path className="funds-proj" d={line} clipPath={`url(#${id}-up)`} />
          {g.crosses && <path className="funds-proj below" d={line} clipPath={`url(#${id}-dn)`} />}
        </svg>
        {g.xy.map((p, i) => {
          const pt = all[i]!
          return (
            <span
              key={i}
              className={'funds-pt' + (i === 0 ? ' rec' : '') + (pt.zat <= 0 ? ' below' : '')}
              style={{ left: pct(p.x, W), top: pct(p.y, height) }}
              title={`${i === 0 ? nowLabel : projectedLabel} (${pt.label}): ${zatToZec(pt.zat)} ZEC`}
            />
          )
        })}
      </div>
      <div className="funds-axis mono" aria-hidden="true">
        {all.map((p, i) => <span key={i}>{p.label}</span>)}
      </div>
      <div className="funds-tags mono" aria-hidden="true">
        <span style={{ left: `${(first.x / W) * 100}%` }}>{nowLabel}</span>
        <span className="end" style={{ left: `${(last.x / W) * 100}%` }}>{projectedLabel}</span>
      </div>
      {runsOut && g.crosses && <p className="chart-warn">{runsOut}</p>}
      <table className="visually-hidden">
        <caption>{title}</caption>
        <tbody>
          <tr><th scope="row">{nowLabel} ({now.label})</th><td>{zatToZec(now.zat)} ZEC</td></tr>
          {ahead.map((p, i) => (
            <tr key={i}><th scope="row">{projectedLabel} ({p.label})</th><td>{zatToZec(p.zat)} ZEC</td></tr>
          ))}
        </tbody>
      </table>
      <figcaption className="chart-src">{source}</figcaption>
    </figure>
  )
}
