import { describe, expect, it } from 'vitest'
import type { Proposal } from './api'
import { codeOf } from './source-scan'
import { BURN_MONTHS, burnRate, monthlyOutflows, projection, runway, type Burn } from './treasury-metrics'

/* The treasury's three numbers, in one place: the pace of spending, how long the free funds last at
 * that pace, and the month-by-month projection. Whole zatoshi (#303). It reads the ledger's SETTLED
 * and the payment screen's freeZatOf, and stops below three complete months of history. A month is
 * placed by the proposal's creation date, because no settlement date is read yet (#300). */

const at = (y: number, m: number, d = 15) => Math.floor(new Date(y, m, d).getTime() / 1000)
let n = 0
const p = (state: string, zat: number, created_at: number | undefined, o: Partial<Proposal> = {}): Proposal => ({
  id: `p${n++}`, vault_id: 'v', kind: 'payment', state, proposer: 'ana', value_zat: zat, value_zec: '',
  is_public: false, created_at, approvals: [], refusals: [], approvals_count: 0, ...o,
})
// "Now" is 10 November 2026: the complete months behind it are October, September, August.
const NOW = new Date(2026, 10, 10)
const bal = (spendable: number) => ({ total_zat: spendable, spendable_zat: spendable })
const rate = (z: number): Burn => ({ kind: 'rate', zatPerMonth: z, undated: 0 })

describe('monthly outflows', () => {
  it('sums what left the vault per complete month, oldest first, and leaves the current month out', () => {
    const r = monthlyOutflows([
      p('sent', 100, at(2026, 9)), p('confirmed', 50, at(2026, 9, 2)),
      p('confirmed', 30, at(2026, 8)),
      p('sent', 999, at(2026, 10, 3)),
    ], NOW, 3)
    expect(r.months.map((m) => m.outZat)).toEqual([0, 30, 150])
    expect(r.months[2]!.from).toBe(Math.floor(new Date(2026, 9, 1).getTime() / 1000))
    expect(r.months[2]!.to).toBe(Math.floor(new Date(2026, 10, 1).getTime() / 1000))
  })
  it('counts only money that left: open, refused, expired and withdrawn proposals are not spending', () => {
    const r = monthlyOutflows(['awaiting', 'ready', 'rejected', 'expired', 'cancelled', 'superseded'].map((s) => p(s, 10, at(2026, 9))), NOW, 1)
    expect(r.months[0]!.outZat).toBe(0)
  })
  it('names the outflows it could not place in a month instead of dropping them in silence', () => {
    expect(monthlyOutflows([p('sent', 70, undefined), p('awaiting', 5, undefined)], NOW, 1).undated).toBe(1)
  })
  it('ignores a value that is not a whole, safe number of zatoshi, as the ledger sums do', () => {
    expect(monthlyOutflows([p('sent', 1.5, at(2026, 9)), p('sent', 4, at(2026, 9))], NOW, 1).months[0]!.outZat).toBe(4)
  })
})

describe('the pace of spending', () => {
  it('averages the last three complete months, rounding up so the runway is never overstated', () => {
    const b = burnRate([
      p('awaiting', 1, at(2026, 5)),
      p('sent', 100, at(2026, 9)), p('sent', 100, at(2026, 8)), p('sent', 101, at(2026, 7)),
      p('sent', 5000, at(2026, 6)), // outside the window
    ], NOW)
    expect(b).toEqual({ kind: 'rate', zatPerMonth: 101, undated: 0 })
  })
  it('a quiet month inside the window counts as a month of no spending', () => {
    expect(burnRate([p('rejected', 1, at(2026, 7, 1)), p('sent', 90, at(2026, 9))], NOW)).toEqual({ kind: 'rate', zatPerMonth: 30, undated: 0 })
  })
  it('stops with fewer than three complete months since the first activity, rather than averaging fewer', () => {
    expect(BURN_MONTHS).toBe(3)
    expect(burnRate([p('sent', 300, at(2026, 8, 1)), p('sent', 100, at(2026, 9))], NOW)).toEqual({ kind: 'not-enough-history' })
    expect(burnRate([p('sent', 10, at(2026, 10, 2))], NOW)).toEqual({ kind: 'not-enough-history' })
    expect(burnRate([], NOW)).toEqual({ kind: 'not-enough-history' })
    expect(burnRate([p('sent', 10, undefined)], NOW)).toEqual({ kind: 'not-enough-history' })
  })
  it('starts only when the first activity is at or before the start of the window, to the second', () => {
    // The window behind 10 November is August, September and October, from 1 August 00:00.
    const aug1 = at(2026, 7, 1)
    expect(burnRate([p('sent', 30, aug1)], NOW)).toEqual({ kind: 'rate', zatPerMonth: 10, undated: 0 })
    expect(burnRate([p('rejected', 1, at(2026, 6, 31)), p('sent', 30, at(2026, 9))], NOW)).toEqual({ kind: 'rate', zatPerMonth: 10, undated: 0 })
    // the last day of the window's first month: three calendar months back, but August is not whole
    const aug31Late = Math.floor(new Date(2026, 7, 31, 23, 59, 59).getTime() / 1000)
    expect(burnRate([p('sent', 30, aug31Late)], NOW)).toEqual({ kind: 'not-enough-history' })
    expect(burnRate([p('sent', 30, aug1 + 1)], NOW)).toEqual({ kind: 'not-enough-history' })
  })
  it('takes a null creation date (the local bridge sends it for older proposals) for no date', () => {
    const nullDated = p('sent', 500, null as unknown as undefined)
    const dated = p('sent', 30, at(2026, 9))
    expect(burnRate([nullDated, dated], NOW)).toEqual({ kind: 'not-enough-history' })
    const r = monthlyOutflows([nullDated, dated], NOW, 3)
    expect(r.undated).toBe(1)
    expect(r.months.map((m) => m.outZat)).toEqual([0, 0, 30])
  })
  it('says nothing about the history of a book it has not read', () => {
    expect(burnRate(null, NOW)).toEqual({ kind: 'unknown' })
    expect(runway(bal(1000), null, burnRate(null, NOW))).toEqual({ kind: 'unknown' })
    expect(projection(bal(1000), [], { kind: 'unknown' }, NOW)).toBeNull()
  })
  it('carries the count of undated outflows so the screen can say what it left out', () => {
    const b = burnRate([p('rejected', 1, at(2026, 7, 1)), p('sent', 30, at(2026, 9)), p('sent', 7, undefined)], NOW)
    expect(b).toEqual({ kind: 'rate', zatPerMonth: 10, undated: 1 })
  })
})

describe('runway', () => {
  it('is the free funds over the pace, in tenths of a month, rounded down', () => {
    expect(runway(bal(1000), [], rate(300))).toEqual({ kind: 'months', tenths: 33 })
    expect(runway(bal(299), [], rate(300))).toEqual({ kind: 'months', tenths: 9 })
    expect(runway(bal(0), [], rate(300))).toEqual({ kind: 'none-free' })
    // open proposals holding more than can be spent: nothing is free now
    expect(runway(bal(100), [p('ready', 200, at(2026, 10, 1))], rate(300))).toEqual({ kind: 'none-free' })
  })
  it('counts only the free funds: what an open proposal holds is not there to last', () => {
    expect(runway(bal(1000), [p('awaiting', 400, at(2026, 10, 1))], rate(300))).toEqual({ kind: 'months', tenths: 20 })
  })
  it('does not divide by a pace it does not have, nor by a pace of zero', () => {
    expect(runway(bal(1000), [], { kind: 'not-enough-history' })).toEqual({ kind: 'unknown' })
    expect(runway(bal(1000), [], rate(0))).toEqual({ kind: 'no-spend' })
  })
  it('does not guess the free funds when the balance or the proposals were not read', () => {
    expect(runway(null, [], rate(300))).toEqual({ kind: 'unknown' })
    expect(runway(bal(1000), null, rate(300))).toEqual({ kind: 'unknown' })
  })
  it('stays exact at the size of the whole supply', () => {
    expect(runway(bal(21_000_000 * 100_000_000), [], rate(100_000_000))).toEqual({ kind: 'months', tenths: 210_000_000 })
  })
})

describe('projection', () => {
  it('repeats the pace month by month from next month and names the first month at or below zero', () => {
    const r = projection(bal(1000), [], rate(300), NOW, 4)!
    expect(r.points.map((x) => x.balanceZat)).toEqual([700, 400, 100, -200])
    expect(r.points[0]!.from).toBe(Math.floor(new Date(2026, 11, 1).getTime() / 1000))
    expect(r.runsOutIndex).toBe(3)
  })
  it('is flat with no spending, and absent without a pace or a balance', () => {
    expect(projection(bal(500), [], rate(0), NOW, 2)).toEqual({ points: [
      { from: Math.floor(new Date(2026, 11, 1).getTime() / 1000), balanceZat: 500 },
      { from: Math.floor(new Date(2027, 0, 1).getTime() / 1000), balanceZat: 500 },
    ], runsOutIndex: null })
    expect(projection(bal(500), [], { kind: 'not-enough-history' }, NOW)).toBeNull()
    expect(projection(null, [], rate(10), NOW)).toBeNull()
  })
  it('says the funds are out from the first month when nothing is free', () => {
    expect(projection(bal(0), [], rate(10), NOW, 2)!.runsOutIndex).toBe(0)
  })
})

describe('one rule, not a third', () => {
  it('reads SETTLED and freeZatOf instead of spelling the states or the subtraction again', () => {
    const code = codeOf('treasury-metrics.ts')
    expect(code).toMatch(/import \{ SETTLED \} from '\.\/ledger-state'/)
    expect(code).toMatch(/import \{ freeZatOf \} from '\.\/balance-parts'/)
    expect(code).not.toMatch(/'sent'|'confirmed'/)
  })
  it("draws a month with the period picker's window, not a calendar of its own", () => {
    const code = codeOf('treasury-metrics.ts')
    expect(code).toMatch(/import \{ createdAt, periodWindow \} from '\.\/period'/)
    expect(code).not.toMatch(/\.created_at/)
    expect(code).not.toMatch(/getMonth\(\)|getFullYear\(\)/)
  })
  it('settlement reads the same SETTLED, with no list of its own', () => {
    const code = codeOf('settlement.ts')
    expect(code).toMatch(/SETTLED\(p\.state\)/)
    // no state spelled as a state: not in a Set, not in an array, not in a comparison
    expect(code).not.toMatch(/'sent'/)
    expect(code).not.toMatch(/\[[^\]]*'confirmed'[^\]]*\]/)
    expect(code).not.toMatch(/state\s*[!=]==?\s*'confirmed'/)
  })
})
