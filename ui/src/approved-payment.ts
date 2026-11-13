// Does a sign-request pay EXACTLY the payment the quorum approved?
//
// This is the missing half of the money gate (#281). H1 already guarantees a device signs the
// sighash of the PCZT it can see and display; what was never enforced is that the PCZT it sees is
// the APPROVED one. `isApproved` shipped stubbed `() => true`, and `isArmed` compared a mutable
// proposal-id label, so a device would contribute its share to whatever request was active while
// its owner had some proposal armed. A hostile helper (or the removed direct-send path, #387) could
// swap the destination under the same label; only a human noticing the preview stood in the way.
//
// The fix binds the decision to the payment's CONTENT: each output's `recipient` (the raw 43-byte
// receiver), its value and its memo. Those reach this function from `readPayment` in the WASM,
// which checks every output against the note commitment the sighash covers, opens each paying
// output the way its recipient will, and refuses anything it cannot confirm (#610). Until #610 the
// device read `recipient` and `value` as the builder wrote them, beside the commitment and not
// bound to it, and this comment called `recipient` ground truth. It was not: a builder could commit
// to one payment and write another into the fields. The advisory `user_address` label is still not
// part of the decision; the WASM now refuses one that names a receiver the output does not pay.
//
// Change is the subtlety: a real send's change output goes to the vault's INTERNAL (change) scope,
// which is neither the external receive address nor anything the device can derive - the device
// deliberately does not hold the UFVK (that would let it read the whole tx graph, #63). So the vault's
// own receivers (external + internal change) are supplied as `ourReceivers`, from a trusted source
// captured at vault creation. An output paying one of those is change/self and is ignored; any other
// paid output is external and must be matched by an approved line, byte for byte.
//
// What this does NOT settle: the approved lines come from the coordinator when the device signs,
// and an approval is bound to the proposal id, not its content (#567).
//
// Pure and exhaustively tested here; the browser wiring (read the request's PCZT via WASM, decode
// the approved UAs to receivers, supply `ourReceivers`) lives in the signing machine and VaultSigner.

/** One Orchard/Ironwood output of a proven PCZT, as the device reads and checks it on-device. */
export interface PcztOutput {
  /** The user-facing address label (`user_address`), if the PCZT carries one. Shown in the preview
   *  and never the basis for the decision. The WASM refuses a label that names a receiver the
   *  output does not pay, so a label that reaches here is the paid address. Change carries `null`. */
  address: string | null
  /** The value in zatoshis, checked against the note commitment. Zero is a dummy padding output. */
  value: number | null
  /** The raw 43-byte Orchard/Ironwood receiver, hex-encoded (lowercase), checked against the note
   *  commitment the sighash covers. `null` only if the PCZT is missing it, which fails closed. */
  recipient: string | null
  /** The memo the recipient will read, opened on the device from the output's own ciphertext:
   *  the text, or `''` for an empty memo. `null` on zero-value outputs and on a memo that is not
   *  text, which no Konclave proposal makes. */
  memo: string | null
}

/** What a proven PCZT pays, as `readPayment` returns it. */
export interface PcztPayment {
  outputs: PcztOutput[]
  /** The fee in zatoshis, from the value balance the sighash covers, already bounded by ZIP 317. */
  feeZat: number
  actions: number
}

/** One approved destination: a single payment is one line, a payroll is N. */
export interface ApprovedLine {
  /** The approved recipient's raw receiver, hex-encoded - decoded on-device from the proposal's UA,
   *  so it is comparable to an output's `recipient`. */
  toReceiver: string
  amountZat: number
  /** The approved memo, `''` when the line has none. */
  memo: string
}

/** Canonical form for a receiver-hex comparison: trimmed, lowercased. Both sides are hex from the
 *  same `to_raw_address_bytes()` encoding, so this only guards against stray case/whitespace. */
function norm(hex: string | null): string | null {
  return hex === null ? null : hex.trim().toLowerCase()
}

/** An address field, from the device's record, a backup or the coordinator, as text or as nothing.
 *  The one reading of it: the money gate, the deposit screen (`getVault`), the backfill, the import
 *  and the creation screen all take an address through here, so a value that is not text means "no
 *  address" everywhere, instead of a throw in one reader and the coordinator's answer in another
 *  (#610 review, A9). */
export function addressText(x: unknown): string {
  return typeof x === 'string' ? x.trim() : ''
}

/** The vault's own receivers (external receive + internal change), from what THIS device recorded
 *  about the vault, or null when it has not recorded both.
 *
 *  These decide what the gate ignores as change, so they cannot come from the party the gate exists
 *  to check. They used to: the external one was decoded from the address the coordinator serves on
 *  every load, so a coordinator that answered with its own address could pay the approved lines
 *  exactly and keep the rest of the spent notes as "change" (#610 review). The record's address is
 *  written at creation, or once by the backfill, and never replaced by a later answer; the change
 *  receiver is write-once in the same way. The coordinator's answer is not even a parameter here.
 *
 *  @param decode a UA to its raw receiver hex (`uaReceiver` in the WASM; injected so this is pure). */
export function ourReceiversFrom(
  rec: { address?: unknown; changeReceiver?: unknown; cp?: number; receiversState?: string; pending?: boolean; abandoned?: string } | undefined,
  decode: (ua: string) => string,
): string[] | null {
  // Protocol 3: only what this device derived from the vault's own key is the vault's own.
  if ((rec?.cp ?? 0) >= 3 && (rec?.receiversState !== 'verified' || rec.pending || rec.abandoned)) return null
  const address = addressText(rec?.address)
  const change = addressText(rec?.changeReceiver)
  if (!address || !change) return null
  return [decode(address), decode(change)]
}

/** Whether this device says it will sign for this vault. The one predicate: an older vault always may. */
export function mayContribute(
  rec: { cp?: number; receiversState?: string; pending?: boolean; abandoned?: string } | undefined,
  refusal: string | undefined,
): boolean {
  if (refusal || !rec) return false
  return (rec.cp ?? 0) < 3 || (rec.receiversState === 'verified' && !rec.pending && !rec.abandoned)
}

/** Does this receiver belong to the vault itself (change, or a payment to its own address)? The one
 *  answer to that question: the gate ignores such outputs, and the signing screen is allowed to call
 *  an unlabelled output change only when this says so (#610). A device that has not loaded the
 *  vault's receivers (`null`) knows nothing to be its own, so it answers no for every output. */
export function paysOurselves(recipient: string | null, ourReceivers: string[] | null): boolean {
  const r = norm(recipient)
  return r !== null && !!ourReceivers && ourReceivers.some((o) => norm(o) === r)
}

/** What the gate answers for a request, and why. `unknown` is a device that could not work out what
 *  was approved (the proposal fetch failed, the record lacks the vault's receivers): it refuses like
 *  a mismatch, but the screen must not present it as evidence against the payment (#610 review). */
export type GateDecision = 'match' | 'mismatch' | 'unknown'

export function gateDecision(
  ctx: { approved: ApprovedLine[]; ourReceivers: string[] } | null,
  outputs: PcztOutput[],
): GateDecision {
  if (!ctx) return 'unknown'
  return matchesApprovedPayment(outputs, ctx.approved, ctx.ourReceivers) ? 'match' : 'mismatch'
}

/** True iff the PCZT's outputs pay EXACTLY `approved` and nothing else to any external receiver.
 *
 *  The rule, and why each clause is fail-closed:
 *   - An output that moves value (value > 0) and does NOT pay one of `ourReceivers` is EXTERNAL and
 *     must be matched one-to-one by an approved line with the same receiver, amount and memo. A
 *     left-over external output is a skim to a third party → refuse. This is what catches a skim
 *     hidden as fake change: a hostile helper can drop the `user_address`, but it cannot make the
 *     committed receiver equal one of the vault's own receivers without controlling the vault's keys.
 *   - Every approved line must be matched → a request that pays fewer beneficiaries than approved, or
 *     a different one, is refused.
 *   - An external output whose `recipient` is null is unverifiable → refuse (fail closed).
 *   - A memo that is not the approved one, including a non-text memo (`null`), does not match.
 *
 *  Outputs paying `ourReceivers` (change/self) and zero/absent-value outputs (dummies) are ignored.
 *  The fee is not this function's question: `readPayment` bounds it before the outputs get here.
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

  // Every value-moving output that does not pay one of our own receivers (or whose recipient we
  // cannot read) is external and must be accounted for by an approved line.
  const external = outputs.filter((o) => {
    if ((o.value ?? 0) <= 0) return false // dummy / zero-value: ignore
    return !paysOurselves(o.recipient, ourReceivers)
  })

  // Match each external output to an approved line, consuming lines so duplicates are handled
  // (a payroll may legitimately pay the same address twice; each needs its own line).
  const remaining = approved.map((l) => ({ to: norm(l.toReceiver), amountZat: l.amountZat, memo: l.memo, used: false }))
  for (const out of external) {
    const r = norm(out.recipient)
    if (r === null) return false // an unreadable external output is unverifiable → fail closed
    const line = remaining.find((l) => !l.used && l.amountZat === out.value && l.to === r && l.memo === out.memo)
    if (!line) return false // an external output with no matching approved line → skim / swap
    line.used = true
  }
  // Every approved line must have been paid (no missing beneficiary).
  return remaining.every((l) => l.used)
}

/** What a proposal asks to pay: the gate compares it and the screens show it. */
export interface ApprovedPlan {
  kind: 'payment' | 'payroll'
  totalZat: number
  memo?: string
  lines: { label?: string | null; address: string; amountZat: number; memo: string; isPublic: boolean }[]
}

/** The slice of a proposal detail this reads (`getProposalDetail`'s answer). */
export interface ProposalDetailView {
  proposal: { kind: string; to_address?: string | null; value_zat: number; memo?: string | null; is_public?: boolean }
  lines: { label?: string | null; address: string; value_zat: number; memo?: string | null; is_public?: boolean }[]
}

const isAmount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0

/**
 * Decide by `kind`, and refuse an answer that does not hold together: a payment with lines, a payroll
 * with none, or whose lines do not sum to its value. The coordinator writes a payment with no lines
 * and a payroll with no address, so an honest vault never lands here. Null means refuse: nothing to
 * show as approved and nothing to compare.
 */
export function approvedPlanOf(detail: ProposalDetailView): ApprovedPlan | null {
  const { proposal: p, lines } = detail
  if (!isAmount(p.value_zat)) return null
  const memo = p.memo ?? undefined
  if (p.kind === 'payment') {
    const address = addressText(p.to_address)
    if (lines.length > 0 || !address) return null
    return {
      kind: 'payment', totalZat: p.value_zat, memo,
      lines: [{ address, amountZat: p.value_zat, memo: p.memo ?? '', isPublic: !!p.is_public }],
    }
  }
  if (p.kind === 'payroll') {
    if (lines.length === 0 || addressText(p.to_address)) return null
    if (!lines.every((l) => isAmount(l.value_zat) && addressText(l.address))) return null
    if (lines.reduce((sum, l) => sum + l.value_zat, 0) !== p.value_zat) return null
    return {
      kind: 'payroll', totalZat: p.value_zat, memo,
      lines: lines.map((l) => ({ label: l.label, address: addressText(l.address), amountZat: l.value_zat, memo: l.memo ?? '', isPublic: !!l.is_public })),
    }
  }
  return null
}

/** The lines the gate compares, from the plan the screens show. `decode` is `uaReceiver` in the WASM,
 *  injected so this stays pure. The memo is part of what was approved (#610): no memo is the empty one. */
export function approvedLinesFor(plan: ApprovedPlan, decode: (address: string) => string): ApprovedLine[] {
  return plan.lines.map((l) => ({ toReceiver: decode(l.address), amountZat: l.amountZat, memo: l.memo }))
}

/** The proposal a screen was reached from. */
export interface SeenProposal { kind: string; to_address?: string | null; value_zat: number; memo?: string | null }

function samePlan(a: ApprovedPlan, b: ApprovedPlan): boolean {
  const key = (p: ApprovedPlan) => JSON.stringify([p.kind, p.totalZat, p.lines.map((l) => [l.address, l.amountZat, l.memo])])
  return key(a) === key(b)
}

/**
 * The plan after a new reading of a proposal, or null. It has to agree with the proposal it was
 * reached from and with any earlier reading, and a refusal stays.
 */
export function planAfterRead(
  seen: SeenProposal,
  previous: ApprovedPlan | null | undefined,
  detail: ProposalDetailView,
): ApprovedPlan | null {
  if (previous === null) return null
  const plan = approvedPlanOf(detail)
  if (!plan) return null
  if (previous && !samePlan(previous, plan)) return null
  if (seen.kind !== plan.kind || seen.value_zat !== plan.totalZat) return null
  if (plan.kind === 'payment') {
    const line = plan.lines[0]
    if (addressText(seen.to_address) !== line?.address || (seen.memo ?? '') !== line.memo) return null
  }
  return plan
}

/** Each proposal's last reading in this session, shared by every screen and the signer. */
const planMemory = new Map<string, ApprovedPlan | null>()

/** `planAfterRead` against the session's memory of this proposal. The one call screens and signer make. */
export function readPlan(id: string, seen: SeenProposal, detail: ProposalDetailView): ApprovedPlan | null {
  const plan = planAfterRead(seen, planMemory.get(id), detail)
  planMemory.set(id, plan)
  return plan
}

/** Refuse this proposal for the rest of the session, on what the screens and the signer read. */
export function refusePlan(id: string): null {
  planMemory.set(id, null)
  return null
}

/** For tests: a new session. */
export function forgetPlansForTests(): void {
  planMemory.clear()
}

/** A key of what a transaction pays: its approved lines (receiver, amount, memo), order-free, hashed.
 *  Read only after the gate matched the transaction to these lines, so it names what it pays. The
 *  device's signing record keeps it so the same payment is recognised under a new proposal id, until
 *  approvals are bound to content (#567). */
export async function paidKey(lines: ApprovedLine[]): Promise<string> {
  const rows = lines.map((l) => [norm(l.toReceiver), l.amountZat, l.memo]).map((r) => JSON.stringify(r)).sort()
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows))))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}
