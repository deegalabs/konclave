import './skeleton.css'
import { useT } from './i18n'

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
 *  to a static block. Purely presentational and hidden from assistive tech; the
 *  word "Loading" is carried by `SkeletonStatus`, once per screen. */
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

/** The one thing assistive tech hears while a screen loads: a live region holding the WORD, not a
 *  label on a decorative block. The text is in the DOM from the first paint (so a screen reader
 *  announces it once, as the region appears) and becomes a visible caption after ~400 ms, so a fast
 *  read never flashes it and a slow one says what the grey blocks mean. Every preset below renders
 *  one by default; a screen that stacks two presets passes `status={false}` to the second, so the
 *  word is announced once per screen rather than once per block. */
export function SkeletonStatus() {
  const t = useT()
  return (
    <div role="status" className="skel-status">
      <span className="skel-status-text">{t('skeleton.loading')}</span>
    </div>
  )
}

type Preset = { className?: string; /** Render the status region (default). `false` on a second preset sharing the screen. */ status?: boolean }

const cx = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' ')

/** A big-number placeholder for the balance figure (amount line + a thin sub line). */
export function SkeletonStat({ className, status = true }: Preset) {
  return (
    <>
      {status && <SkeletonStatus />}
      <div className={cx('skel-stat', className)} aria-hidden="true">
        <span className="skel skel-amt" />
        <span className="skel skel-sub" />
      </div>
    </>
  )
}

/** `n` placeholder rows for a table/list body (date · title/sub · value). `compact` is the
 *  one-line row of a short history (date · value), 40 px tall. */
export function SkeletonRows({ n = 4, compact = false, className, status = true }: Preset & { n?: number; compact?: boolean }) {
  return (
    <>
      {status && <SkeletonStatus />}
      <div className={cx('skel-rows', compact && 'skel-rows-compact', className)} aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <div className="skel-row" key={i}>
            <span className="skel skel-line skel-r-date" />
            <div className="skel-r-main">
              <span className="skel skel-line skel-r-t" />
              {!compact && <span className="skel skel-line skel-r-sub" />}
            </div>
            <span className="skel skel-line skel-r-val" />
          </div>
        ))}
      </div>
    </>
  )
}

/** `n` people: a round mark, a name over a sub line, and a tag at the end - the shape of a roster. */
export function SkeletonRoster({ n = 3, className, status = true }: Preset & { n?: number }) {
  return (
    <>
      {status && <SkeletonStatus />}
      <div className={cx('skel-roster', className)} aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <div className="skel-person" key={i}>
            <span className="skel skel-p-mark" />
            <div className="skel-r-main">
              <span className="skel skel-line skel-r-t" />
              <span className="skel skel-line skel-r-sub" />
            </div>
            <span className="skel skel-pill skel-p-tag" />
          </div>
        ))}
      </div>
    </>
  )
}

/** `fields` label-and-input pairs and a button: the shape of a form that is still deciding what it
 *  may offer. `inline` lays the fields side by side, the way a short header row of a form does. */
export function SkeletonForm({ fields = 3, inline = false, className, status = true }: Preset & { fields?: number; inline?: boolean }) {
  return (
    <>
      {status && <SkeletonStatus />}
      <div className={cx('skel-form', inline && 'skel-form-inline', className)} aria-hidden="true">
        {Array.from({ length: fields }, (_, i) => (
          <div className="skel-field" key={i}>
            <span className="skel skel-line skel-f-label" />
            <span className="skel skel-block skel-f-input" />
          </div>
        ))}
        {!inline && <span className="skel skel-pill skel-f-btn" />}
      </div>
    </>
  )
}

/** A detail page: a title line, a sub line, the amount when the page has one, then `rows` lines
 *  of facts. A settings page is the same shape without the amount. */
export function SkeletonDetail({ rows = 3, amount = false, className, status = true }: Preset & { rows?: number; amount?: boolean }) {
  return (
    <>
      {status && <SkeletonStatus />}
      <div className={cx('skel-detail', className)} aria-hidden="true">
        <span className="skel skel-line skel-d-title" />
        <span className="skel skel-line skel-d-sub" />
        {amount && <span className="skel skel-d-amt" />}
        {Array.from({ length: rows }, (_, i) => <span className="skel skel-line skel-d-row" key={i} />)}
      </div>
    </>
  )
}

/** The square a QR code will fill, at the size the Receive page draws it. */
export function SkeletonQr({ className, status = true }: Preset) {
  return (
    <>
      {status && <SkeletonStatus />}
      <span className={cx('skel skel-qr', className)} aria-hidden="true" />
    </>
  )
}
