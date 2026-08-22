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
  it('repeats are penalized', () => {
    expect(scorePassphrase('aaaaaaaa').label).toBe('weak')
  })
  it('a long mixed passphrase is good or strong', () => {
    expect(scorePassphrase('tavu-keby-3-lomi-daxo').score).toBeGreaterThanOrEqual(3)
    expect(scorePassphrase('Tr0ub4dour-&-3xtra-Long!').score).toBeGreaterThanOrEqual(3)
  })
})

describe('generatePassphrase', () => {
  it('generates a distinct, strong-enough passphrase each time', () => {
    const a = generatePassphrase()
    const b = generatePassphrase()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[a-z0-9-]+$/)
    expect(a.split('-').length).toBe(5) // 4 words + 1 number
    expect(scorePassphrase(a).score).toBeGreaterThanOrEqual(3)
  })
})
