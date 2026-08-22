import { describe, expect, it } from 'vitest'
import { fmtZec, parseZecToZat, zatToZec, expiryLabel, fmtDate, fingerprintCode, vaultFingerprint } from './format'
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
    expect(fmtZec('')).toBe('-')
    expect(fmtZec(undefined)).toBe('-')
    expect(fmtZec('abc')).toBe('-')
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
  it('renders DD/MM/YYYY from a real unix timestamp', () => {
    // Build in LOCAL time so format (which reads local getDate/getMonth) is tz-independent.
    const unix = Math.floor(new Date(2026, 4, 4, 12, 0, 0).getTime() / 1000) // 2026-05-04
    expect(fmtDate(unix)).toBe('04/05/2026') // default (pt-BR)
    expect(fmtDate(unix, 'pt-BR')).toBe('04/05/2026')
    expect(fmtDate(unix, 'en')).toBe('05/04/2026') // en -> MM/DD/YYYY
  })
  it('returns - for absent/invalid, never NaN', () => {
    expect(fmtDate(undefined)).toBe('-')
    expect(fmtDate(0)).toBe('-')
    expect(fmtDate(Number.MAX_SAFE_INTEGER)).toBe('-')
  })
})

describe('fingerprintCode (pure - vault fingerprint encoding, #65 I4)', () => {
  it('is deterministic and formatted as three groups of three Crockford chars', () => {
    const d = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
    const code = fingerprintCode(d)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/)
    expect(fingerprintCode(d)).toBe(code) // same bytes -> same code
  })
  it('excludes the ambiguous letters I, L, O, U', () => {
    // exercise many byte patterns; none of the ambiguous glyphs may appear
    for (let i = 0; i < 64; i++) {
      const code = fingerprintCode(new Uint8Array([i, i * 3, i * 7, i * 11, i * 13, i * 17]))
      expect(code).not.toMatch(/[ILOU]/)
    }
  })
  it('different digests yield different codes (uses the top 45 bits)', () => {
    const a = fingerprintCode(new Uint8Array([9, 9, 9, 9, 9, 9]))
    const b = fingerprintCode(new Uint8Array([8, 9, 9, 9, 9, 9]))
    expect(a).not.toBe(b)
  })
})

describe('vaultFingerprint (SHA-256 of the public group identity)', () => {
  it('same group key -> same code; case/whitespace-insensitive', async () => {
    const gk = 'a25c53f7bf9a6f68b8b105503b23e6e22dd4033b00f5f9e6bb35b4bcd709a73a'
    const a = await vaultFingerprint(gk)
    expect(a).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}-[0-9A-Z]{3}$/)
    expect(await vaultFingerprint('  ' + gk.toUpperCase() + '  ')).toBe(a)
  })
  it('a different group (impostor/separate DKG) -> a different code', async () => {
    const a = await vaultFingerprint('a25c53f7bf9a6f68b8b105503b23e6e22dd4033b00f5f9e6bb35b4bcd709a73a')
    const b = await vaultFingerprint('6b207009592233c7ab835765f35093ed357380589a4380a4d0cfd3c9d0c00c0b')
    expect(a).not.toBe(b)
  })
})
