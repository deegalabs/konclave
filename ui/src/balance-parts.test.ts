import { describe, expect, it } from 'vitest'
import { balanceParts } from './balance-parts'

describe('balanceParts', () => {
  it('splits a balance into free, reserved and confirming', () => {
    // 0.0048 total, 0.0040 spendable, 0.0008 claimed by open proposals.
    const b = balanceParts(480_000, 400_000, 80_000)
    expect(b.freeZat).toBe(320_000)
    expect(b.reservedZat).toBe(80_000)
    expect(b.confirmingZat).toBe(80_000)
  })

  it('reports FREE, not spendable - reserved is already claimed', () => {
    // This is #293's ask. Showing 400_000 here would invite a second proposal against money the
    // first one has already committed.
    expect(balanceParts(400_000, 400_000, 150_000).freeZat).toBe(250_000)
  })

  it('the three parts always sum to the total', () => {
    for (const [t, s, r] of [
      [480_000, 400_000, 80_000],
      [1, 1, 0],
      [1_000, 0, 0],
      [999_999, 333_333, 111_111],
    ]) {
      const b = balanceParts(t!, s!, r!)
      expect(b.freeZat + b.reservedZat + b.confirmingZat).toBe(b.totalZat)
    }
  })

  it('flags an over-committed vault instead of hiding it behind a clamp', () => {
    // Open proposals claim more than the vault can spend: something approved cannot be paid.
    const b = balanceParts(500_000, 300_000, 400_000)
    expect(b.overCommitted).toBe(true)
    expect(b.reservedZat).toBe(300_000) // clamped so the bar cannot overflow
    expect(b.freeZat).toBe(0)
    expect(b.freeZat + b.reservedZat + b.confirmingZat).toBe(500_000)
  })

  it('is not over-committed when the claim exactly matches what is spendable', () => {
    const b = balanceParts(500_000, 300_000, 300_000)
    expect(b.overCommitted).toBe(false)
    expect(b.freeZat).toBe(0)
  })

  it('treats everything as confirming when nothing is spendable yet', () => {
    // The state the vault was in all of 2026-08-27 morning: funded, nothing usable.
    const b = balanceParts(490_000, 0, 0)
    expect(b.confirmingZat).toBe(490_000)
    expect(b.pct).toEqual({ free: 0, reserved: 0, confirming: 100 })
  })

  it('never returns a negative part, whatever the backend says', () => {
    const b = balanceParts(100, 500, 900) // spendable > total, reserved > both
    expect(b.freeZat).toBeGreaterThanOrEqual(0)
    expect(b.reservedZat).toBeGreaterThanOrEqual(0)
    expect(b.confirmingZat).toBeGreaterThanOrEqual(0)
    expect(b.totalZat).toBe(100)
  })

  it('returns all zeros for an empty vault rather than dividing by zero', () => {
    const b = balanceParts(0, 0, 0)
    expect(b.pct).toEqual({ free: 0, reserved: 0, confirming: 0 })
    expect(b.overCommitted).toBe(false)
  })

  it('percentages sum to exactly 100, so the bar has no hairline gap', () => {
    // Thirds are the classic case where three floors sum to 99.
    for (const [t, s, r] of [
      [3, 2, 1],
      [7, 5, 2],
      [1_000_003, 666_669, 333_334],
      [999_999, 333_333, 111_111],
    ]) {
      const { pct } = balanceParts(t!, s!, r!)
      expect(pct.free + pct.reserved + pct.confirming).toBe(100)
    }
  })

  it('rounds fractional zatoshi rather than carrying them into the bar', () => {
    const b = balanceParts(100.4, 60.6, 10.5)
    expect(Number.isInteger(b.totalZat)).toBe(true)
    expect(Number.isInteger(b.freeZat)).toBe(true)
    expect(b.freeZat + b.reservedZat + b.confirmingZat).toBe(b.totalZat)
  })
})
