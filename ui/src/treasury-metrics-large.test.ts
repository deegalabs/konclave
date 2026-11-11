import { describe, expect, it } from 'vitest'
import { burnRate } from './treasury-metrics'

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
