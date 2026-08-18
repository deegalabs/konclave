// Shared formatting helpers - single source of truth for money, dates, and expiry,
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
export function fmtZec(zec?: string | number, fallback = '-'): string {
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

/** DD/MM/YYYY date from a real unix timestamp (seconds). '-' when absent/invalid, never NaN.
 *  Year-qualified: a ledger handed to an accountant must distinguish 2026 from 2027. */
export function fmtDate(unix?: number): string {
  if (!isRealUnix(unix)) return '-'
  const d = new Date(unix * 1000)
  if (Number.isNaN(d.getTime())) return '-'
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}

/** Abbreviate a long address/hex for display: head…tail. */
export function shortAddr(addr: string, head = 6, tail = 6): string {
  if (addr.length <= head + tail + 1) return addr
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`
}

// Crockford base32 (no I/L/O/U) - unambiguous when read aloud or copied by hand.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Pure: encode the first bytes of a digest as a 9-char code grouped 3-3-3 (≈45 bits).
 *  Deterministic and side-effect free so it can be unit-tested without WebCrypto. */
export function fingerprintCode(digest: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < digest.length && out.length < 9; i++) {
    value = (value << 8) | (digest[i] ?? 0)
    bits += 8
    while (bits >= 5 && out.length < 9) {
      bits -= 5
      out += CROCKFORD[(value >>> bits) & 31]
    }
  }
  return `${out.slice(0, 3)}-${out.slice(3, 6)}-${out.slice(6, 9)}`
}

/** A short, human-comparable fingerprint of a vault's PUBLIC group identity (its group verifying
 *  key hex). In FROST DKG the group key is a function of every participant's contribution, so every
 *  device that ran the SAME ceremony derives the SAME code, and a separate/impostor DKG derives a
 *  DIFFERENT one. Members read it aloud out of band to confirm one shared vault + roster - the
 *  detection half of authenticated admission (#65 / ADR-0007 I4; the PIN is the prevention half). */
export async function vaultFingerprint(identity: string): Promise<string> {
  const data = new TextEncoder().encode(identity.trim().toLowerCase())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return fingerprintCode(digest)
}
