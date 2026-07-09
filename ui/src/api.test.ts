import { describe, expect, it } from 'vitest'
import { shortAddr, classifyAddress, isTransparent, humanError } from './api'
import type { TFn } from './i18n'

// Fake translator: returns the key so we can assert which message humanError picked.
const t: TFn = (key) => key

describe('shortAddr', () => {
  it('elides the middle of a long address', () => {
    const a = 'u1vjgxlvz4ewnt43rkq6fzexpld406dr'
    expect(shortAddr(a)).toBe('u1vjgx…d406dr')
  })
  it('leaves short strings untouched', () => {
    expect(shortAddr('u1abc')).toBe('u1abc')
  })
})

describe('classifyAddress / isTransparent (mirrors the backend prefix heuristic)', () => {
  it('classifies by prefix', () => {
    expect(classifyAddress('u1abc')).toBe('unified')
    expect(classifyAddress('zs1abc')).toBe('sapling')
    expect(classifyAddress('t1abc')).toBe('transparent')
    expect(classifyAddress('t3abc')).toBe('transparent')
    expect(classifyAddress('nope')).toBe('unknown')
  })
  it('flags transparent (public) destinations', () => {
    expect(isTransparent('t1abc')).toBe(true)
    expect(isTransparent('u1abc')).toBe(false)
  })
})

describe('humanError (technical code → i18n message, §6.11)', () => {
  it('maps known backend codes to human keys', () => {
    expect(humanError(t, 'insufficient funds')).toBe('error.insufficient')
    expect(humanError(t, 'send failed')).toBe('error.ceremony')
    expect(humanError(t, 'invalid address')).toBe('error.invalidAddress')
    expect(humanError(t, 'no vault')).toBe('error.noVault')
    expect(humanError(t, 'expired')).toBe('error.expired')
    expect(humanError(t, 'no connection')).toBe('error.noConnection')
  })
  it('matches on detail substrings too', () => {
    expect(humanError(t, 'x', 'frostd transport refused')).toBe('error.ceremony')
    expect(humanError(t, 'x', 'apply_signature failed')).toBe('error.share')
  })
  it('falls back to a short readable detail, else a generic message', () => {
    expect(humanError(t, 'weird', 'a concise readable reason')).toBe('a concise readable reason')
    expect(humanError(t, undefined, undefined)).toBe('error.unexpected')
    const huge = 'x'.repeat(200)
    expect(humanError(t, huge, huge)).toBe('error.unexpected')
  })
})
