// Does a sign-request pay EXACTLY the payment the quorum approved?
//
// This is the missing half of the money gate (#281). H1 already guarantees a device signs the
// sighash of the PCZT it can see and display; what was never enforced is that the PCZT it sees is
// the APPROVED one. `isApproved` shipped stubbed `() => true`, and `isArmed` compared a mutable
// proposal-id label, so a device would contribute its share to whatever request was active while
// its owner had some proposal armed. A hostile helper (or the removed direct-send path, #387) could
// swap the destination under the same label; only a human noticing the preview stood in the way.
//
// The fix binds the decision to the payment's CONTENT. The PCZT carries every Orchard output's
// recipient address and value in cleartext (`describeOutputs`, and the confidentiality cost of that
// is #63); the approved proposal carries the same. So the device can compare them on-device, without
// trusting the helper's labels, and refuse a request that does not pay exactly what was approved.
//
// Pure and exhaustively tested here; the browser wiring (decode the request's PCZT, look up the
// armed/ready proposal) lives in the gate and VaultSigner.

/** One Orchard output as `describeOutputs` reports it: the cleartext recipient + value, or nulls
 *  when the PCZT does not expose them. */
export interface PcztOutput {
  address: string | null
  value: number | null
}

/** One approved destination: a single payment is one line, a payroll is N. */
export interface ApprovedLine {
  to: string
  amountZat: number
}

/** Compare two unified-address strings for the purpose of "is this the approved recipient".
 *  Trimmed exact match: the helper builds the PCZT from the proposal's own `to`, so the strings are
 *  the same source. Case is NOT folded - a UA is case-sensitive bech32m. */
function sameAddress(a: string, b: string): boolean {
  return a.trim() === b.trim()
}

/** True iff the PCZT's outputs pay EXACTLY `approved` and nothing else to any external address.
 *
 *  `vaultAddress` is the vault's own receive address, used to tell change (an output back to the
 *  vault) from a real external payment. The rule, and why each clause is fail-closed:
 *
 *   - Every EXTERNAL output (non-null address, positive value, address ≠ the vault) must be matched
 *     one-to-one by an approved line with the same address and amount. A left-over external output
 *     is a skim to a third party → refuse.
 *   - Every approved line must be matched → a request that pays fewer beneficiaries than approved,
 *     or a different one, is refused.
 *   - An output with a POSITIVE value but a NULL address cannot be verified as change or as an
 *     approved recipient → refuse (fail closed). Our own sends always expose the address.
 *
 *  Outputs to the vault's own address (change) and zero/absent-value outputs (dummies) are ignored.
 *  This binds destination-swap, amount-swap, and skim; it does not check memos (describeOutputs does
 *  not surface them - a separate concern, #63/privacy).
 */
export function matchesApprovedPayment(
  outputs: PcztOutput[],
  approved: ApprovedLine[],
  vaultAddress: string,
): boolean {
  if (approved.length === 0) return false // nothing was approved: never sign

  // An unreadable positive-value output is unverifiable → fail closed.
  if (outputs.some((o) => (o.value ?? 0) > 0 && o.address === null)) return false

  const external = outputs.filter(
    (o) => o.address !== null && (o.value ?? 0) > 0 && !sameAddress(o.address, vaultAddress),
  )

  // Match each external output to an approved line, consuming lines so duplicates are handled
  // (a payroll may legitimately pay the same address twice; each needs its own line).
  const remaining = approved.map((l) => ({ ...l, used: false }))
  for (const out of external) {
    const line = remaining.find(
      (l) => !l.used && l.amountZat === out.value && sameAddress(l.to, out.address as string),
    )
    if (!line) return false // an external output with no matching approved line → skim / swap
    line.used = true
  }
  // Every approved line must have been paid (no missing beneficiary).
  return remaining.every((l) => l.used)
}
