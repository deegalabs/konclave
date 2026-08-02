// Restrained in-app charts. The brand is an "instrument, not a dashboard" (STYLE.md: Variance 2,
// Motion 2, the tarja is the one ornament), so these are matte, single-series, unanimated, and use
// text/silver ink for the marks — the blue accent stays reserved for interactive + quorum.

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
export function SpendBars({ data, unit = 'ZEC', height = 52 }: { data: SpendPoint[]; unit?: string; height?: number }) {
  if (!data || data.length < 2) return null
  const max = Math.max(...data.map((d) => d.zec), 0)
  // data has >= 2 items here (guarded above), so reduce with no initial is safe and stays typed
  // as SpendPoint (never undefined) — unlike passing data[0] under noUncheckedIndexedAccess.
  const peak = data.reduce((a, b) => (b.zec > a.zec ? b : a))
  const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })

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
      {/* Offscreen table fallback — identity/value never color-alone. */}
      <table className="visually-hidden">
        <caption>Spend by period</caption>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}><th scope="row">{d.label}</th><td>{fmt(d.zec)} {unit}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
