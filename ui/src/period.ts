// The ledger's period picker: a window by month, quarter or year, walked with an offset from now.
// Pure arithmetic, no React and no clock of its own, so the screen and a test share one rule. An
// entry is placed in a window by its creation date; "all" is no window at all.

export type PeriodKind = 'all' | 'month' | 'quarter' | 'year'

/** Unix seconds, half-open: an entry belongs when `from <= created_at < to`. */
export type PeriodWindow = { from: number; to: number }

const unix = (d: Date) => Math.floor(d.getTime() / 1000)

/** The window `offset` units away from the one holding `now` (0 = the current one, -1 = the previous). */
export function periodWindow(kind: PeriodKind, offset: number, now: Date = new Date()): PeriodWindow | null {
  if (kind === 'all') return null
  const y = now.getFullYear()
  const m = now.getMonth()
  let start: Date
  let end: Date
  if (kind === 'month') {
    start = new Date(y, m + offset, 1)
    end = new Date(y, m + offset + 1, 1)
  } else if (kind === 'quarter') {
    const q0 = Math.floor(m / 3) * 3
    start = new Date(y, q0 + 3 * offset, 1)
    end = new Date(y, q0 + 3 * offset + 3, 1)
  } else {
    start = new Date(y + offset, 0, 1)
    end = new Date(y + offset + 1, 0, 1)
  }
  return { from: unix(start), to: unix(end) }
}

/** The window's name in the member's language: "October 2025", "Q4 2025" (via `quarter`), "2025". */
export function periodLabel(
  kind: PeriodKind,
  offset: number,
  now: Date,
  locale: string,
  quarter: (q: number, year: number) => string,
): string {
  const w = periodWindow(kind, offset, now)
  if (!w) return ''
  const start = new Date(w.from * 1000)
  if (kind === 'month') return start.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
  if (kind === 'quarter') return quarter(Math.floor(start.getMonth() / 3) + 1, start.getFullYear())
  return String(start.getFullYear())
}

/**
 * The offset that keeps `anchor` in view after a change of kind: a member reading March 2026 who
 * switches to quarters lands on Q1 2026, not on the current quarter.
 */
export function offsetFor(kind: PeriodKind, anchor: Date, now: Date = new Date()): number {
  if (kind === 'all') return 0
  const dy = anchor.getFullYear() - now.getFullYear()
  if (kind === 'year') return dy
  if (kind === 'quarter') return dy * 4 + Math.floor(anchor.getMonth() / 3) - Math.floor(now.getMonth() / 3)
  return dy * 12 + anchor.getMonth() - now.getMonth()
}

/** Whether an entry created at `createdAt` (unix seconds) falls in the window; no window takes everything. */
export function inPeriod(w: PeriodWindow | null, createdAt?: number): boolean {
  if (!w) return true
  return createdAt !== undefined && createdAt >= w.from && createdAt < w.to
}
