// Does a sign-request pay EXACTLY the payment the quorum approved?
//
// This is the missing half of the money gate (#281). H1 already guarantees a device signs the
// sighash of the PCZT it can see and display; what was never enforced is that the PCZT it sees is
// the APPROVED one. `isApproved` shipped stubbed `() => true`, and `isArmed` compared a mutable
// proposal-id label, so a device would contribute its share to whatever request was active while
// its owner had some proposal armed. A hostile helper (or the removed direct-send path, #387) could
// swap the destination under the same label; only a human noticing the preview stood in the way.
//
// The fix binds the decision to the payment's CONTENT, and to the ONE field that is ground truth:
// each Orchard/Ironwood output's `recipient` - the raw 43-byte receiver the Constructor set, that
// the Prover needs, and that the note commitment (and thus the sighash) is bound to. The advisory
// `user_address` label is NOT trusted for the decision: the helper controls it, so it could label an
// attacker's output with the victim's address while `recipient` (what actually gets paid) is the
// attacker's. The orchard PCZT spec says the same - a Signer must confirm `user_address` contains
// `recipient` - so we compare recipients directly and treat the label as display only.
//
// Change is the subtlety: a real send's change output goes to the vault's INTERNAL (change) scope,
// which is neither the external receive address nor anything the device can derive - the device
// deliberately does not hold the UFVK (that would let it read the whole tx graph, #63). So the vault's
// own receivers (external + internal change) are supplied as `ourReceivers`, from a trusted source
// captured at vault creation. An output paying one of those is change/self and is ignored; any other
// paid output is external and must be matched by an approved line, byte for byte.
//
// Pure and exhaustively tested here; the browser wiring (decode the request's PCZT to recipients via
// WASM, decode the approved UAs to receivers, supply `ourReceivers`) lives in the gate and VaultSigner.

/** One Orchard/Ironwood output of a proven PCZT, as the device reads it on-device. */
export interface PcztOutput {
  /** The user-facing address label (`user_address`), if the PCZT exposes it. ADVISORY ONLY - shown
   *  in the preview, never the basis for the security decision (the helper controls it). Change
   *  outputs carry `null` here. */
  address: string | null
  /** The value in zatoshis, or null when absent. Zero/absent value is a dummy padding output. */
  value: number | null
  /** The raw 43-byte Orchard/Ironwood receiver, hex-encoded (lowercase). This is the GROUND TRUTH of
   *  who gets paid - bound into the note commitment the sighash covers. Present for every real
   *  output; `null` only if the PCZT is missing it, which is unverifiable and fails closed. */
  recipient: string | null
}

/** One approved destination: a single payment is one line, a payroll is N. */
export interface ApprovedLine {
  /** The approved recipient's raw receiver, hex-encoded - decoded on-device from the proposal's UA,
   *  so it is comparable to an output's `recipient`. */
  toReceiver: string
  amountZat: number
}

/** Canonical form for a receiver-hex comparison: trimmed, lowercased. Both sides are hex from the
 *  same `to_raw_address_bytes()` encoding, so this only guards against stray case/whitespace. */
function norm(hex: string | null): string | null {
  return hex === null ? null : hex.trim().toLowerCase()
}

/** True iff the PCZT's outputs pay EXACTLY `approved` and nothing else to any external receiver.
 *
 *  The rule, and why each clause is fail-closed:
 *   - An output that moves value (value > 0) and does NOT pay one of `ourReceivers` is EXTERNAL and
 *     must be matched one-to-one by an approved line with the same receiver and amount. A left-over
 *     external output is a skim to a third party → refuse. This is what catches a skim hidden as
 *     fake change: a hostile helper can drop the `user_address`, but it cannot make the recipient
 *     bytes equal one of the vault's own receivers without controlling the vault's keys.
 *   - Every approved line must be matched → a request that pays fewer beneficiaries than approved, or
 *     a different one, is refused.
 *   - An external output whose `recipient` is null is unverifiable → refuse (fail closed).
 *
 *  Outputs paying `ourReceivers` (change/self) and zero/absent-value outputs (dummies) are ignored.
 *  This binds destination-swap, amount-swap, and skim; it does not check memos (not surfaced here -
 *  a separate concern, #63/privacy).
 *
 *  @param ourReceivers the vault's own receivers (external receive + internal change), hex-encoded,
 *                      from a trusted source captured at vault creation.
 */
export function matchesApprovedPayment(
  outputs: PcztOutput[],
  approved: ApprovedLine[],
  ourReceivers: string[],
): boolean {
  if (approved.length === 0) return false // nothing was approved: never sign

  const ours = new Set(ourReceivers.map((r) => norm(r)).filter((r): r is string => r !== null))

  // Every value-moving output that does not pay one of our own receivers (or whose recipient we
  // cannot read) is external and must be accounted for by an approved line.
  const external = outputs.filter((o) => {
    if ((o.value ?? 0) <= 0) return false // dummy / zero-value: ignore
    const r = norm(o.recipient)
    return r === null || !ours.has(r)
  })

  // Match each external output to an approved line, consuming lines so duplicates are handled
  // (a payroll may legitimately pay the same address twice; each needs its own line).
  const remaining = approved.map((l) => ({ to: norm(l.toReceiver), amountZat: l.amountZat, used: false }))
  for (const out of external) {
    const r = norm(out.recipient)
    if (r === null) return false // an unreadable external output is unverifiable → fail closed
    const line = remaining.find((l) => !l.used && l.amountZat === out.value && l.to === r)
    if (!line) return false // an external output with no matching approved line → skim / swap
    line.used = true
  }
  // Every approved line must have been paid (no missing beneficiary).
  return remaining.every((l) => l.used)
}
