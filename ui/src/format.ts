// Shared formatting helpers — single source of truth for money, dates, and expiry,
// so screens don't each reimplement (and diverge on) the same logic.
//
// Money mirrors the backend's Zatoshis (orchestrator/src/money.rs): 8 fractional digits,
// integer zatoshis, no floating-point drift.

import type { TFn } from './i18n'

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

/** Parse a ZEC decimal string into integer zatoshis, mirroring money.rs::from_zec_str,
 *  without floating point. Accepts `12`, `1.5`, `.5`, `5.` (typing-friendly); rejects empty,
 *  a lone dot, non-numeric, negative, or > 8 fractional digits. Returns null when invalid. */
export function parseZecToZat(zec: string): number | null {
  const s = (zec ?? '').trim()
  if (!/^(\d+\.?\d{0,8}|\.\d{1,8})$/.test(s)) return null
  const [w = '', f = ''] = s.split('.')
  const whole = w === '' ? 0 : parseInt(w, 10)
  const frac = parseInt((f + '00000000').slice(0, 8) || '0', 10)
  const zat = whole * ZAT_PER_ZEC + frac
  return Number.isSafeInteger(zat) ? zat : null
}

/** Format integer zatoshis as a full ZEC decimal string (8 places). */
export function zatToZec(zat: number): string {
  return (zat / ZAT_PER_ZEC).toFixed(8)
}

/** Human expiry label from an expiry unix (seconds). Empty string when there is no expiry
 *  (missing, or the "never expires" sentinel). */
export function expiryLabel(unix: number | undefined, t: TFn): string {
  if (!isRealUnix(unix)) return ''
  const ms = unix * 1000 - Date.now()
  if (ms <= 0) return t('expiry.expired')
  const h = Math.floor(ms / 3_600_000)
  return h < 48 ? t('expiry.hours', { h }) : t('expiry.days', { d: Math.floor(h / 24) })
}

/** DD/MM/YYYY date from a real unix timestamp (seconds). '—' when absent/invalid, never NaN.
 *  Year-qualified: a ledger handed to an accountant must distinguish 2026 from 2027. */
export function fmtDate(unix?: number): string {
  if (!isRealUnix(unix)) return '—'
  const d = new Date(unix * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}
