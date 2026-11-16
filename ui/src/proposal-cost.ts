// What an open proposal takes out of the vault: its value plus the network fee estimated for the
// outputs it pays (#1017). This is the ONE place that adds the two, so "reserved", "free" and the
// insufficient-balance check cannot come to count different things for the same proposal.
//
// Pure: it imports types only and takes the estimator as a parameter, like `proposeBlock` takes
// `feeZat`, so a test needs no wasm and a screen passes whatever `useFeeEstimate` gave it. The fee
// rule is not here either (it lives in `konclave_seal::epochs`, read by `fee-estimate.ts`).
//
// It answers `null`, never a lower bound, when it cannot know: no estimator yet, or a proposal whose
// destinations were not read. Falling back to `estimate(1)` would show a figure that leaves out
// money that really leaves the vault, which is the very error #1017 reports.
import type { Proposal } from './api'
import type { FeeEstimator } from './fee-estimate'

/** value + the estimate for `destinations`, the one addition. A screen still BUILDING a proposal has
 *  no `Proposal` object, only an amount and a count, and calls this directly; `null` when either the
 *  estimator or the count is unknown. */
export function costZat(
  valueZat: number,
  destinations: number | null | undefined,
  estimate: FeeEstimator | null,
): number | null {
  if (!estimate) return null
  if (typeof destinations !== 'number' || !Number.isInteger(destinations) || destinations < 1) return null
  const fee = estimate(destinations)
  if (fee === null) return null
  return valueZat + fee
}

export function proposalCostZat(p: Proposal, estimate: FeeEstimator | null): number | null {
  return costZat(p.value_zat, p.destinations, estimate)
}
