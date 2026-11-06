// The network fee a screen shows and reserves before a payment is built.
//
// The rule is NOT here. It lives in `konclave_seal::epochs` (ZIP 317 and the ZIP 2009 fee eras) and
// the device reads it through the wasm with its own clock: this file only asks. There is no number
// typed here and no default, because a second copy of the rule is how the payment screen came to
// reserve 15,000 while the proposal showed 10,000 for the same payment (#692). Until the wasm has
// answered, the estimate is `null`, and a screen that needs one says so and blocks, as it does for
// a balance it cannot read.
//
// This is an ESTIMATE and always will be: only the wallet knows its note selection (#206, #293).
// What the device signs is checked against the transaction itself, in WASM, and must be exactly the
// ZIP 317 fee of the actions it carries at a rate its clock allows.
import { useEffect, useState } from 'react'
import { ensureWasm } from './wasm-ready'
import { estimatedFeeZat as estimateFromRule } from './wasm-pkg/konclave_wasm.js'

/** The fee in zatoshis for a payment to `destinations` (at least one). */
export type FeeEstimator = (destinations: number) => number

/** The estimator, or `null` when the rule cannot answer: the wasm reads no clock window (a clock
 *  before the network this app signs for) or answers something that is not a positive whole number.
 *  Each call reads the clock again, so a screen left open across the fee switch follows it. The wasm
 *  must be ready (`ensureWasm`). */
export function readFeeEstimator(estimate: (destinations: number) => number = estimateFromRule): FeeEstimator | null {
  const ok = (v: number) => Number.isInteger(v) && v > 0
  if (!ok(estimate(1))) return null
  return (destinations: number) => {
    const v = estimate(Math.max(1, Math.floor(destinations)))
    return ok(v) ? v : Number.NaN
  }
}

/** Where the estimate stands on a screen: still loading, unusable (with the reason shown), or ready. */
export type FeeEstimate =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; estimate: FeeEstimator }

/** The estimate for a screen. `unavailable` when the wasm fails to load or the rule cannot answer,
 *  so the screen can say why instead of showing a dead button. */
export function useFeeEstimate(): FeeEstimate {
  const [s, setS] = useState<FeeEstimate>({ state: 'loading' })
  useEffect(() => {
    let live = true
    ensureWasm()
      .then(() => {
        if (!live) return
        const estimate = readFeeEstimator()
        setS(estimate ? { state: 'ready', estimate } : { state: 'unavailable' })
      })
      .catch(() => {
        if (live) setS({ state: 'unavailable' })
      })
    return () => {
      live = false
    }
  }, [])
  return s
}

/** The estimator when ready, else `null`. */
export function estimatorOf(s: FeeEstimate): FeeEstimator | null {
  return s.state === 'ready' ? s.estimate : null
}
