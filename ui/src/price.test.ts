import { describe, it, expect } from 'vitest'
import { zecToUsd, rateIsStale, type Rate } from './price'

const rate: Rate = { usd: 40, at: Date.now(), source: 'Test' }

describe('price — pure conversion + staleness', () => {
  it('converts a ZEC string to a USD currency string at the given rate', () => {
    expect(zecToUsd('2.5', rate)).toBe('$100.00')
    expect(zecToUsd(0, rate)).toBe('$0.00')
  })

  it('returns null when there is no rate or the amount is not a number', () => {
    expect(zecToUsd('2.5', null)).toBeNull()
    expect(zecToUsd(undefined, rate)).toBeNull()
    expect(zecToUsd('not-a-number', rate)).toBeNull()
  })

  it('flags a rate older than the TTL (10 min) as stale, and a null rate as stale', () => {
    expect(rateIsStale(null)).toBe(true)
    expect(rateIsStale({ usd: 40, at: Date.now(), source: 'Test' })).toBe(false)
    expect(rateIsStale({ usd: 40, at: Date.now() - 11 * 60 * 1000, source: 'Test' })).toBe(true)
  })
})
