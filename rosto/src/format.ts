// Shared formatting helpers — single source of truth for money, dates, and expiry,
// so screens don't each reimplement (and diverge on) the same logic.
//
// Money mirrors the backend's Zatoshis (orquestrador/src/money.rs): 8 fractional digits,
// integer zatoshis, no floating-point drift.

const ZAT_PER_ZEC = 100_000_000

/** Far-future unix (seconds) horizon. The backend uses i64::MAX to mean "never expires";
 *  anything at/beyond a sane horizon (≈ year 5000) is treated as "no real timestamp" so the
 *  sentinel and any overflow never render as an absurd "…d" or an Invalid Date. */
const MAX_SANE_UNIX = 95_617_584_000

function isRealUnix(unix?: number): unix is number {
  return typeof unix === 'number' && Number.isFinite(unix) && unix > 0 && unix < MAX_SANE_UNIX
}

/** Format a ZEC amount (string or number) with 4 decimals. Falls back when not finite. */
export function fmtZec(zec?: string | number, fallback = '—'): string {
  if (zec === undefined || zec === null || zec === '') return fallback
  const n = typeof zec === 'number' ? zec : Number(zec)
  return Number.isFinite(n) ? n.toFixed(4) : fallback
}

/** Parse a ZEC decimal string into integer zatoshis, mirroring money.rs::from_zec_str.
 *  Returns null on invalid input (empty, non-numeric, negative, or > 8 fractional digits). */
export function parseZecToZat(zec: string): number | null {
  const s = (zec ?? '').trim()
  if (!/^\d+(\.\d{1,8})?$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const zat = Number(whole) * ZAT_PER_ZEC + Number(frac.padEnd(8, '0'))
  return Number.isSafeInteger(zat) ? zat : null
}

/** Human expiry label from an expiry unix (seconds). Empty string when there is no expiry
 *  (missing, or the "never expires" sentinel). */
export function expiryLabel(unix?: number): string {
  if (!isRealUnix(unix)) return ''
  const ms = unix * 1000 - Date.now()
  if (ms <= 0) return 'expirada'
  const h = Math.floor(ms / 3_600_000)
  return h < 48 ? `expira em ${h}h` : `expira em ${Math.floor(h / 24)}d`
}

/** Short DD/MM date from a real unix timestamp (seconds). '—' when absent/invalid — never NaN. */
export function fmtDate(unix?: number): string {
  if (!isRealUnix(unix)) return '—'
  const d = new Date(unix * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}
