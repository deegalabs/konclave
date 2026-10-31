import { describe, expect, it } from 'vitest'
import { offsetFor, periodWindow } from './period'

// The ledger's period picker: a window by month, quarter or year, walked with an offset from now.
// Pure, so the arithmetic is tested without a browser; the screen places each entry by creation date.
describe('the ledger period window', () => {
  const now = new Date(2025, 10, 15, 12) // 2025-11-15
  const unix = (d: Date) => Math.floor(d.getTime() / 1000)

  it('"all" is no window', () => {
    expect(periodWindow('all', 0, now)).toBeNull()
  })

  it('a month runs from its first day to the next first day, and the offset walks months', () => {
    expect(periodWindow('month', 0, now)).toEqual({ from: unix(new Date(2025, 10, 1)), to: unix(new Date(2025, 11, 1)) })
    expect(periodWindow('month', -1, now)).toEqual({ from: unix(new Date(2025, 9, 1)), to: unix(new Date(2025, 10, 1)) })
    expect(periodWindow('month', -11, now)).toEqual({ from: unix(new Date(2024, 11, 1)), to: unix(new Date(2025, 0, 1)) })
  })

  it('a quarter and a year the same way', () => {
    expect(periodWindow('quarter', 0, now)).toEqual({ from: unix(new Date(2025, 9, 1)), to: unix(new Date(2026, 0, 1)) })
    expect(periodWindow('quarter', -1, now)).toEqual({ from: unix(new Date(2025, 6, 1)), to: unix(new Date(2025, 9, 1)) })
    expect(periodWindow('year', -1, now)).toEqual({ from: unix(new Date(2024, 0, 1)), to: unix(new Date(2025, 0, 1)) })
  })

  it('switching the kind keeps the date in view: the offset is recomputed from the window start', () => {
    const march = new Date(2026, 2, 1) // reading March 2026 while now is 2025-11-15
    expect(offsetFor('quarter', march, now)).toBe(1) // Q1 2026 is one quarter after Q4 2025
    expect(offsetFor('year', march, now)).toBe(1)
    expect(offsetFor('month', march, now)).toBe(4)
    expect(offsetFor('all', march, now)).toBe(0)
  })
})
