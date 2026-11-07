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
// and no projection, only "not enough history". Rounding leans the safe way: the pace rounds UP
// and the runway rounds DOWN, so the vault never looks like it lasts longer than its book supports.
// Whole zatoshi throughout (#303).
import type { Proposal } from './api'
import { freeZatOf } from './balance-parts'
import { sumZat } from './format'
import { SETTLED } from './ledger-state'

/** Complete months a pace is averaged over, and the least history that may speak of one. */
export const BURN_MONTHS = 3

type Bal = Parameters<typeof freeZatOf>[0]

const unix = (d: Date) => Math.floor(d.getTime() / 1000)
const monthStart = (now: Date, offset: number) => new Date(now.getFullYear(), now.getMonth() + offset, 1)

export type MonthOut = { from: number; to: number; outZat: number }

/** The `count` complete months before the one holding `now`, oldest first, with what left the vault
 *  in each. Outflows with no creation date cannot be placed and are counted in `undated`. */
export function monthlyOutflows(proposals: readonly Proposal[], now: Date, count: number): { months: MonthOut[]; undated: number } {
  const out = proposals.filter((p) => SETTLED(p.state))
  const undated = out.filter((p) => p.created_at === undefined).length
  const months: MonthOut[] = []
  for (let k = count; k >= 1; k--) {
    const from = unix(monthStart(now, -k))
    const to = unix(monthStart(now, -k + 1))
    months.push({ from, to, outZat: sumZat(out.filter((p) => p.created_at !== undefined && p.created_at >= from && p.created_at < to)) })
  }
  return { months, undated }
}

export type Burn =
  /** Fewer than `BURN_MONTHS` complete months since the vault was first used. */
  | { kind: 'not-enough-history' }
  /** The average spent per month over the last `BURN_MONTHS` complete months, rounded up. */
  | { kind: 'rate'; zatPerMonth: number; undated: number }

/** The pace of spending, once the vault has `BURN_MONTHS` complete months since its first proposal
 *  of any kind. A quiet month inside that span counts as zero. */
export function burnRate(proposals: readonly Proposal[], now: Date = new Date()): Burn {
  const dated = proposals.map((p) => p.created_at).filter((t): t is number => t !== undefined)
  if (dated.length === 0) return { kind: 'not-enough-history' }
  const first = new Date(Math.min(...dated) * 1000)
  const complete = (now.getFullYear() - first.getFullYear()) * 12 + now.getMonth() - first.getMonth()
  if (complete < BURN_MONTHS) return { kind: 'not-enough-history' }
  const r = monthlyOutflows(proposals, now, BURN_MONTHS)
  const total = r.months.reduce((acc, m) => acc + m.outZat, 0)
  return { kind: 'rate', zatPerMonth: Math.ceil(total / BURN_MONTHS), undated: r.undated }
}

export type Runway =
  /** No pace yet (not enough history), or the balance or the proposals have not been read. */
  | { kind: 'unknown' }
  | { kind: 'no-spend' }
  /** Months the free funds last at the pace, in tenths, rounded down (33 = 3.3 months). */
  | { kind: 'months'; tenths: number }

/** How long the free funds last at the pace. */
export function runway(bal: Bal, proposals: readonly Proposal[] | null, burn: Burn): Runway {
  const free = freeZatOf(bal, proposals)
  if (burn.kind !== 'rate' || free === null) return { kind: 'unknown' }
  if (burn.zatPerMonth <= 0) return { kind: 'no-spend' }
  const f = Math.max(0, free)
  // Whole months, then the tenths of the remainder: never multiplies the free funds, so it stays
  // exact even for a balance near the whole supply.
  const whole = Math.floor(f / burn.zatPerMonth)
  const rest = f - whole * burn.zatPerMonth
  return { kind: 'months', tenths: whole * 10 + Math.floor((rest * 10) / burn.zatPerMonth) }
}

export type ProjectionPoint = { from: number; balanceZat: number }

/** The free funds one, two, ... `horizon` months from now (each point dated by the month it falls
 *  in) if the pace holds and nothing comes in; `runsOutIndex` is the first point at or below zero.
 *  Null when there is no pace or the free funds are unknown. */
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
  for (let k = 1; k <= horizon; k++) points.push({ from: unix(monthStart(now, k)), balanceZat: free - k * burn.zatPerMonth })
  const i = burn.zatPerMonth > 0 ? points.findIndex((x) => x.balanceZat <= 0) : -1
  return { points, runsOutIndex: i === -1 ? null : i }
}
