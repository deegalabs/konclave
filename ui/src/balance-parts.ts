// The vault's balance as a composition, not a single number.
//
// A shielded balance is three different facts wearing one figure, and the dashboard used to print
// them as three unrelated lines. They are not unrelated - they add up to the total, and which part
// a treasurer is looking at decides whether a payment can be made at all:
//
//   free        what can be committed right now
//   reserved    held by open proposals. A PRODUCT rule, not a protocol lock (CLAUDE.md §6.14)
//   confirming  on the chain but not yet spendable by the wallet's confirmation policy
//
// `free` is deliberately not "spendable". `spendable` is what the wallet would let you spend;
// subtracting what open proposals already claim is what you can spend WITHOUT double-committing,
// which is the number a person is actually asking for (#293).
//
// Pure and zatoshi-integer: money is never summed in floating point here (#303).

export type BalanceParts = {
  /** Spendable minus what open proposals already claim. Never negative. */
  freeZat: number
  /** Claimed by open proposals, capped at spendable so the parts always sum to the total. */
  reservedZat: number
  /** On chain, not yet spendable. */
  confirmingZat: number
  /** The three above, summed. Equals `totalZat` when the inputs are consistent. */
  totalZat: number
  /** Percentages of the total, rounded, summing to 100 when the total is positive. */
  pct: { free: number; reserved: number; confirming: number }
  /**
   * True when open proposals claim MORE than the vault can spend. The vault is over-committed:
   * some approved proposal cannot be paid even though it looks ready. Worth surfacing, not hiding
   * behind a clamped bar.
   */
  overCommitted: boolean
}

/**
 * Split a balance into its three parts. All inputs in zatoshi.
 *
 * `spendableZat` is clamped to `totalZat` and `reservedZat` to `spendableZat`, so the parts always
 * sum to the total and a bar built from them can never overflow its track - but `overCommitted`
 * records that the clamp happened rather than swallowing it.
 */
export function balanceParts(totalZat: number, spendableZat: number, reservedZat: number): BalanceParts {
  const total = Math.max(0, Math.round(totalZat))
  const spendable = Math.min(total, Math.max(0, Math.round(spendableZat)))
  const wanted = Math.max(0, Math.round(reservedZat))
  const reserved = Math.min(spendable, wanted)
  const free = spendable - reserved
  const confirming = total - spendable

  // Largest-remainder rounding, so the three percentages sum to exactly 100 and the bar has no
  // hairline gap or overflow at the end.
  const pct = split100([free, reserved, confirming], total)

  return {
    freeZat: free,
    reservedZat: reserved,
    confirmingZat: confirming,
    totalZat: total,
    pct: { free: pct[0]!, reserved: pct[1]!, confirming: pct[2]! },
    overCommitted: wanted > spendable,
  }
}

/** Percentages that sum to exactly 100 (or all zero when there is nothing to split). */
function split100(parts: number[], total: number): number[] {
  if (total <= 0) return parts.map(() => 0)
  const exact = parts.map((p) => (p / total) * 100)
  const floors = exact.map(Math.floor)
  let left = 100 - floors.reduce((a, b) => a + b, 0)
  // Hand the leftover points to the largest fractional remainders first.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  const out = [...floors]
  for (const { i } of order) {
    if (left <= 0) break
    out[i] = out[i]! + 1
    left--
  }
  return out
}
