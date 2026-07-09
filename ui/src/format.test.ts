import { describe, expect, it } from 'vitest'
import { fmtZec, parseZecToZat, zatToZec, expiryLabel, fmtDate } from './format'
import type { TFn } from './i18n'

// A fake translator: echoes the key with its vars, so we can assert which label was chosen.
const t: TFn = (key, vars) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key

describe('parseZecToZat (mirrors money.rs::from_zec_str, no floating point)', () => {
  it('parses integers, decimals, and typing-friendly forms', () => {
    expect(parseZecToZat('1')).toBe(100_000_000)
    expect(parseZecToZat('1.5')).toBe(150_000_000)
    expect(parseZecToZat('0.00000001')).toBe(1) // one zatoshi
    expect(parseZecToZat('.5')).toBe(50_000_000)
    expect(parseZecToZat('5.')).toBe(500_000_000)
    expect(parseZecToZat('  0.001  ')).toBe(100_000) // trimmed
  })

  it('rejects invalid input rather than guessing', () => {
    expect(parseZecToZat('')).toBeNull()
    expect(parseZecToZat('.')).toBeNull()
    expect(parseZecToZat('abc')).toBeNull()
    expect(parseZecToZat('-1')).toBeNull()
    expect(parseZecToZat('1.234567890')).toBeNull() // > 8 fractional digits
    expect(parseZecToZat('1,5')).toBeNull() // comma is not a decimal point
  })

  it('round-trips with zatToZec', () => {
    for (const zec of ['0.00000001', '1.23456789', '21000000']) {
      const zat = parseZecToZat(zec)
      expect(zat).not.toBeNull()
      expect(zatToZec(zat as number)).toBe(Number(zec).toFixed(8))
    }
  })
})

describe('fmtZec', () => {
  it('formats to 4 decimals from string or number', () => {
    expect(fmtZec('0.0005')).toBe('0.0005')
    expect(fmtZec(1.23456)).toBe('1.2346')
    expect(fmtZec('12')).toBe('12.0000')
  })
  it('falls back on empty / non-finite', () => {
    expect(fmtZec('')).toBe('—')
    expect(fmtZec(undefined)).toBe('—')
    expect(fmtZec('abc')).toBe('—')
    expect(fmtZec('', 'n/a')).toBe('n/a')
  })
})

describe('expiryLabel', () => {
  it('is empty when there is no real expiry (missing or the "never" sentinel)', () => {
    expect(expiryLabel(undefined, t)).toBe('')
    expect(expiryLabel(0, t)).toBe('')
    expect(expiryLabel(Number.MAX_SAFE_INTEGER, t)).toBe('') // beyond the sane horizon
  })
  it('reports expired when the moment has passed', () => {
    const past = Math.floor(Date.now() / 1000) - 3600
    expect(expiryLabel(past, t)).toBe('expiry.expired')
  })
  it('uses hours under 48h and days beyond', () => {
    const inTenHours = Math.floor(Date.now() / 1000) + 10 * 3600
    expect(expiryLabel(inTenHours, t)).toMatch(/^expiry\.hours\(h=\d+\)$/)
    const inThreeDays = Math.floor(Date.now() / 1000) + 3 * 24 * 3600
    expect(expiryLabel(inThreeDays, t)).toMatch(/^expiry\.days\(d=\d+\)$/)
  })
})

describe('fmtDate', () => {
  it('renders DD/MM from a real unix timestamp', () => {
    // Build in LOCAL time so format (which reads local getDate/getMonth) is tz-independent.
    const unix = Math.floor(new Date(2026, 4, 4, 12, 0, 0).getTime() / 1000) // 2026-05-04 → 04/05
    expect(fmtDate(unix)).toBe('04/05')
  })
  it('returns — for absent/invalid, never NaN', () => {
    expect(fmtDate(undefined)).toBe('—')
    expect(fmtDate(0)).toBe('—')
    expect(fmtDate(Number.MAX_SAFE_INTEGER)).toBe('—')
  })
})
