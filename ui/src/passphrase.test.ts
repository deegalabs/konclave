import { describe, it, expect } from 'vitest'
import { scorePassphrase, generatePassphrase } from './passphrase'

describe('scorePassphrase', () => {
  it('empty is score 0', () => {
    expect(scorePassphrase('').label).toBe('empty')
  })
  it('short single-class is weak', () => {
    expect(scorePassphrase('senha').score).toBeLessThanOrEqual(1)
    expect(scorePassphrase('12345678').score).toBeLessThanOrEqual(1)
  })
  it('common starts are penalized', () => {
    expect(scorePassphrase('password1').score).toBeLessThanOrEqual(1)
  })
  it('judges complexity, not quantity: a long single repeated char is weak', () => {
    expect(scorePassphrase('aaaaaaaa').label).toBe('weak')
    // The reported bug: 25 identical characters must NOT read as strong.
    expect(scorePassphrase('a'.repeat(25)).score).toBeLessThanOrEqual(1)
  })
  it('a long mixed passphrase is good or strong', () => {
    expect(scorePassphrase('tavu-keby-3-lomi-daxo').score).toBeGreaterThanOrEqual(3)
    expect(scorePassphrase('Tr0ub4dour-&-3xtra-Long!').score).toBeGreaterThanOrEqual(3)
  })
})

describe('generatePassphrase', () => {
  it('generates a distinct, strong vault password using every character class', () => {
    const a = generatePassphrase()
    const b = generatePassphrase()
    expect(a).not.toBe(b)
    expect(a.length).toBe(20)
    expect(a).toMatch(/[a-z]/)
    expect(a).toMatch(/[A-Z]/)
    expect(a).toMatch(/[0-9]/)
    expect(a).toMatch(/[^A-Za-z0-9]/)
    expect(scorePassphrase(a).score).toBe(4)
  })

  // The test above checked ONE password, and about 3 in 1,000 generated ones scored 2 or 3: 20
  // random characters sometimes hold a character three times in a row, or a run like "defg", and
  // the meter marks both down. So the member saw "fair" on the password the app chose for them,
  // and CI went red at random (2026-09-29). One sample cannot see a rate like that; thousands can.
  it('every generated password is rated strong by the meter the screen shows', () => {
    const N = 10_000
    const notStrong: string[] = []
    const malformed: string[] = []
    for (let i = 0; i < N; i++) {
      const p = generatePassphrase()
      const everyClass = /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p)
      if (p.length !== 20 || !everyClass) malformed.push(p)
      if (scorePassphrase(p).score !== 4) notStrong.push(p)
    }
    expect(malformed, 'every password is 20 characters and uses every class').toEqual([])
    expect(notStrong.length, `${notStrong.length} of ${N} were not rated strong, e.g. ${notStrong.slice(0, 3).join(' ')}`)
      .toBe(0)
  })

  it('stops after a bounded number of draws and says so, instead of looping forever', () => {
    let draws = 0
    const neverStrong = () => { draws++; return 'aaaaaaaaaaaaaaaaaaaa' }
    expect(() => generatePassphrase(neverStrong)).toThrow(/strong/)
    expect(draws).toBeGreaterThan(1)
    expect(draws).toBeLessThanOrEqual(64)
  })
})
