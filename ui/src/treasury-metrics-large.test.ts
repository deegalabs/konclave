import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { burnRate } from './treasury-metrics'
import { dateRange } from './period'

// F-1: `Math.min(...dated)` spreads every proposal into the call's arguments, and the engine refuses
// a call with too many (a RangeError), which took the whole treasury view down with it.
describe('burnRate on a very large history', () => {
  it('answers instead of throwing when there are more proposals than a call can take as arguments', () => {
    const now = new Date('2026-11-01T00:00:00Z')
    const created = Math.floor(Date.parse('2026-10-15T00:00:00Z') / 1000)
    const many = Array.from({ length: 200_000 }, (_, i) => ({ id: `p${i}`, created_at: created }))
    expect(() => burnRate(many as never, now)).not.toThrow()
  })
})

describe('the oldest and newest date of a large, unordered history', () => {
  const big = (lo: number, hi: number) => {
    const xs = Array.from({ length: 200_000 }, (_, i) => 1_700_000_000 + ((i * 7919) % 100_000))
    xs[150_000] = lo
    xs[3] = hi
    return xs
  }
  it('dateRange answers the true minimum and maximum, wherever they sit', () => {
    expect(dateRange(big(1_600_000_000, 1_800_000_000))).toEqual({ lo: 1_600_000_000, hi: 1_800_000_000 })
    expect(dateRange([])).toBeNull()
    expect(dateRange([5])).toEqual({ lo: 5, hi: 5 })
  })
  it('burnRate takes the oldest proposal from anywhere in the list, not the first', () => {
    const now = new Date('2026-11-10T12:00:00Z')
    const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)
    const mk = (t: number, i: number) => ({ id: `p${i}`, created_at: t, state: 'sent', value_zat: 1000 })
    const recent = Array.from({ length: 200_000 }, (_, i) => mk(at('2026-11-05T00:00:00Z'), i))
    recent[150_000] = mk(at('2026-05-05T00:00:00Z'), 150_000)
    expect(burnRate(recent as never, now).kind).toBe('rate')
    expect(burnRate(recent.map((p) => ({ ...p, created_at: at('2026-11-05T00:00:00Z') })) as never, now).kind).toBe('not-enough-history')
  })
  it('no screen or metric spreads a history into Math.min or Math.max (Ledger and burnRate share dateRange)', () => {
    for (const f of ['./screens/Ledger.tsx', './treasury-metrics.ts']) {
      const code = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
      expect(code, f).not.toMatch(/Math\.(min|max)\(\.\.\./)
      expect(code, f).toMatch(/dateRange\(/)
    }
  })
})
