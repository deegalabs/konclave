// The treasury's three numbers, written once: how fast the vault spends, how long its free funds
// last at that pace, and what the free funds look like month by month if the pace holds.
//
// It adds no rule of its own. What counts as spent is the ledger's `SETTLED` (money that left the
// vault, broadcast or confirmed); what counts as free is `freeZatOf` (confirmed funds less what open
// proposals hold), the same number the payment screen gates on.
//
// What these numbers are, and what they are not (the screen says the same three things):
//   - A payment is placed in a month by the proposal's CREATION date, on this device's calendar,
//     the same rule as the ledger's period picker (`period.ts`): no settlement date is read (#300).
//   - The network fee is not included: only the proposal's value is read.
//   - Incoming money is not read (#188), so the projection only subtracts.
// It is arithmetic over the book, not a forecast and not a guarantee.
//
// It STOPS rather than guess: below three complete months of history there is no pace, no runway
// and no projection, only "not enough history"; with no book read there is no pace at all, only
// "unknown". A creation date the bridge sends as null (older proposals) is no date: such an outflow
// is counted as undated and opens no history. Rounding leans the safe way: the pace rounds UP
// and the runway rounds DOWN, so the vault never looks like it lasts longer than its book supports.
// Whole zatoshi throughout (#303).
import type { Proposal } from './api'
import { freeZatOf } from './balance-parts'
import { sumZat } from './format'
import { SETTLED } from './ledger-state'
import { createdAt, periodWindow } from './period'

/** Complete months a pace is averaged over, and the least history that may speak of one. */
export const BURN_MONTHS = 3

type Bal = Parameters<typeof freeZatOf>[0]

/** The calendar month `offset` months from the one holding `now`, as the ledger's period picker
 *  draws it (one rule for what a month is). */
const month = (now: Date, offset: number) => periodWindow('month', offset, now)!

export type MonthOut = { from: number; to: number; outZat: number }

/** The `count` complete months before the one holding `now`, oldest first, with what left the vault
 *  in each. Outflows with no creation date cannot be placed and are counted in `undated`. */
export function monthlyOutflows(proposals: readonly Proposal[], now: Date, count: number): { months: MonthOut[]; undated: number } {
  const out = proposals.filter((p) => SETTLED(p.state))
  const undated = out.filter((p) => createdAt(p) === null).length
  const months: MonthOut[] = []
  for (let k = count; k >= 1; k--) {
    const { from, to } = month(now, -k)
    months.push({ from, to, outZat: sumZat(out.filter((p) => { const t = createdAt(p); return t !== null && t >= from && t < to })) })
  }
  return { months, undated }
}

export type Burn =
  /** The proposals have not been read: nothing can be said, not even that the history is short. */
  | { kind: 'unknown' }
  /** Fewer than `BURN_MONTHS` complete months since the vault was first used. */
  | { kind: 'not-enough-history' }
  /** The average spent per month over the last `BURN_MONTHS` complete months, rounded up. */
  | { kind: 'rate'; zatPerMonth: number; undated: number }

/** The pace of spending, once the vault's first proposal of any kind is at or before the start of
 *  the `BURN_MONTHS` complete months it averages, so every one of them is a whole month of the
 *  vault's life. A quiet month inside that span counts as zero. */
export function burnRate(proposals: readonly Proposal[] | null, now: Date = new Date()): Burn {
  if (proposals === null) return { kind: 'unknown' }
  const dated = proposals.map(createdAt).filter((t): t is number => t !== null)
  if (dated.length === 0) return { kind: 'not-enough-history' }
  // A loop, not `Math.min(...dated)`: a spread passes every entry as an argument, and a long history
  // exceeds what a call can take (a RangeError that took the whole treasury view down).
  const oldest = dated.reduce((a, b) => (b < a ? b : a), dated[0]!)
  if (oldest > month(now, -BURN_MONTHS).from) return { kind: 'not-enough-history' }
  const r = monthlyOutflows(proposals, now, BURN_MONTHS)
  const total = r.months.reduce((acc, m) => acc + m.outZat, 0)
  return { kind: 'rate', zatPerMonth: Math.ceil(total / BURN_MONTHS), undated: r.undated }
}

export type Runway =
  /** No pace (not enough history, or no book read), or the balance or the proposals have not been read. */
  | { kind: 'unknown' }
  | { kind: 'no-spend' }
  /** Nothing is free now (open proposals hold it all, or the vault is empty): gone now, not next month. */
  | { kind: 'none-free' }
  /** Months the free funds last at the pace, in tenths, rounded down (33 = 3.3 months). */
  | { kind: 'months'; tenths: number }

/** How long the free funds last at the pace. */
export function runway(bal: Bal, proposals: readonly Proposal[] | null, burn: Burn): Runway {
  const free = freeZatOf(bal, proposals)
  if (burn.kind !== 'rate' || free === null) return { kind: 'unknown' }
  if (burn.zatPerMonth <= 0) return { kind: 'no-spend' }
  const f = Math.max(0, free)
  if (f === 0) return { kind: 'none-free' }
  // Whole months, then the tenths of the remainder: never multiplies the free funds, so it stays
  // exact even for a balance near the whole supply.
  const whole = Math.floor(f / burn.zatPerMonth)
  const rest = f - whole * burn.zatPerMonth
  return { kind: 'months', tenths: whole * 10 + Math.floor((rest * 10) / burn.zatPerMonth) }
}

/** The sentence that goes with a runway, on the screen and in the export: one choice, so the two
 *  cannot say different things about the same vault. */
export function runwayNoteKey(run: Runway): string {
  if (run.kind === 'months') return 'analyses.runwayHow'
  if (run.kind === 'no-spend') return 'analyses.noSpend'
  if (run.kind === 'none-free') return 'analyses.noFreeNow'
  return 'analyses.runwayAwaitsBalance'
}

export type ProjectionPoint = { from: number; balanceZat: number }

/** The free funds one, two, ... `horizon` months from now (each point dated by the month it falls
 *  in) if the pace holds and nothing comes in; `runsOutIndex` is the first point at or below zero.
 *  Null when there is no pace or the free funds are unknown. Zero free funds puts `runsOutIndex` at
 *  0, but that vault is out now, not next month: read `runway()`'s `none-free` first. */
export function projection(
  bal: Bal,
  proposals: readonly Proposal[] | null,
  burn: Burn,
  now: Date = new Date(),
  horizon = 6,
): { points: ProjectionPoint[]; runsOutIndex: number | null } | null {
  const free = freeZatOf(bal, proposals)
  if (burn.kind !== 'rate' || free === null) return null
  const points: ProjectionPoint[] = []
  for (let k = 1; k <= horizon; k++) points.push({ from: month(now, k).from, balanceZat: free - k * burn.zatPerMonth })
  const i = burn.zatPerMonth > 0 ? points.findIndex((x) => x.balanceZat <= 0) : -1
  return { points, runsOutIndex: i === -1 ? null : i }
}
