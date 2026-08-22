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
})
