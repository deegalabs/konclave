import './skeleton.css'

type Variant = 'line' | 'block' | 'pill'

type SkeletonProps = {
  /** CSS width (e.g. '60%', 120, '8rem'). Defaults to full width. */
  width?: number | string
  /** CSS height (e.g. 14, '2rem'). Overrides the variant's height. */
  height?: number | string
  /** CSS border-radius override. */
  radius?: number | string
  /** Shape preset: `line` (thin text row), `block` (card/box), `pill` (rounded tag). */
  variant?: Variant
  className?: string
  style?: React.CSSProperties
}

const px = (v?: number | string) => (typeof v === 'number' ? `${v}px` : v)

/** A single token-colored placeholder with a subtle shimmer sweep.
 *  The sweep turns OFF under prefers-reduced-motion (see skeleton.css), degrading
 *  to a static block. Purely presentational; announce loading via the caller's
 *  existing role="status"/aria copy, so it is hidden from assistive tech here. */
export function Skeleton({ width, height, radius, variant = 'line', className, style }: SkeletonProps) {
  const cls = ['skel', `skel-${variant}`, className].filter(Boolean).join(' ')
  return (
    <span
      aria-hidden="true"
      className={cls}
      style={{ width: px(width), height: px(height), borderRadius: px(radius), ...style }}
    />
  )
}

/** A big-number placeholder for the balance figure (amount line + a thin sub line). */
export function SkeletonStat({ className }: { className?: string }) {
  return (
    <div className={['skel-stat', className].filter(Boolean).join(' ')} role="status" aria-label="Loading">
      <span aria-hidden="true" className="skel skel-amt" />
      <span aria-hidden="true" className="skel skel-sub" />
    </div>
  )
}

/** `n` placeholder rows for a table/list body (date · title/sub · value). */
export function SkeletonRows({ n = 4, className }: { n?: number; className?: string }) {
  return (
    <div className={['skel-rows', className].filter(Boolean).join(' ')} role="status" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div className="skel-row" key={i}>
          <span aria-hidden="true" className="skel skel-line skel-r-date" />
          <div className="skel-r-main">
            <span aria-hidden="true" className="skel skel-line skel-r-t" />
            <span aria-hidden="true" className="skel skel-line skel-r-sub" />
          </div>
          <span aria-hidden="true" className="skel skel-line skel-r-val" />
        </div>
      ))}
    </div>
  )
}
