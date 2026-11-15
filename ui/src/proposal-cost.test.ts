import { describe, it, expect } from 'vitest'
import { costZat, proposalCostZat } from './proposal-cost'
import type { Proposal } from './api'
import type { FeeEstimator } from './fee-estimate'

// An injected estimator with a per-destination component, so a test can tell estimate(1) from
// estimate(N). No fee number from the real rule is typed here: the expectation is built from the
// estimator itself, so a re-measure of the floor cannot break these.
const estimate: FeeEstimator = (n) => 1_000 * (n + 3)

const proposal = (over: Partial<Proposal>): Proposal => ({
  id: 'p', vault_id: 'v', kind: 'payment', state: 'awaiting', proposer: 'A',
  value_zat: 10_000, value_zec: '0.0001', is_public: false,
  approvals: [], refusals: [], approvals_count: 0, ...over,
})

describe('proposalCostZat', () => {
  it('a payment costs its value plus the estimate for one destination', () => {
    expect(proposalCostZat(proposal({ destinations: 1 }), estimate)).toBe(10_000 + estimate(1)!)
  })

  it('a payroll costs its value plus the estimate for ITS line count, not for one', () => {
    const cost = proposalCostZat(proposal({ kind: 'payroll', destinations: 7 }), estimate)
    expect(cost).toBe(10_000 + estimate(7)!)
    expect(cost).not.toBe(10_000 + estimate(1)!)
  })

  it('is unknown without an estimator', () => {
    expect(proposalCostZat(proposal({ destinations: 1 }), null)).toBeNull()
  })

  it('is unknown when the estimator stops answering', () => {
    expect(proposalCostZat(proposal({ destinations: 1 }), () => null)).toBeNull()
  })

  it('is unknown when the destinations were not read, and never falls back to one', () => {
    for (const destinations of [undefined, null, 0, -1, 1.5, NaN]) {
      expect(proposalCostZat(proposal({ kind: 'payroll', destinations }), estimate)).toBeNull()
    }
  })
})

describe('costZat', () => {
  it('is value plus the estimate for the count, and unknown without either', () => {
    expect(costZat(500, 4, estimate)).toBe(500 + estimate(4)!)
    expect(costZat(500, 4, null)).toBeNull()
    expect(costZat(500, null, estimate)).toBeNull()
    expect(costZat(500, 0, estimate)).toBeNull()
  })
  it('is what proposalCostZat answers', () => {
    const p = proposal({ kind: 'payroll', destinations: 5, value_zat: 777 })
    expect(proposalCostZat(p, estimate)).toBe(costZat(777, 5, estimate))
  })
})
