// The rule that decides whether a payment or a payroll may be proposed.
//
// It lived inline in two screens and FAILED OPEN in both. The shape was:
//
//     const afterZat = availableZat == null || amountZat == null ? null : available - amount - fee
//     const overBalance = afterZat !== null && afterZat < 0        // null -> false -> "all clear"
//
// so any figure the app could not parse silently switched the guard off. Two separate inputs
// reached that hole: a balance that could not be read (`available` falls back to `'-'`, which
// `parseZecToZat` rejects) and an amount with a comma decimal (rejected by the same parser, while
// the screens' own submit check used a looser `parseFloat` that accepted it).
//
// Money fails CLOSED here: "I do not know" is never "go ahead". The backend refuses an unfundable
// proposal anyway - this exists so a member is told which field to fix instead of meeting a dead
// button or a proposal that dies later.

/** Why proposing is blocked, or `null` when it is clear. */
export type ProposeBlock =
  | 'memo'
  | 'amount'
  | 'balance-unknown'
  | 'no-funds'
  | 'over-balance'
  | 'crosses-pools'
  | null

export interface ProposeInput {
  /** The amount in zatoshis, already parsed with `parseZecToZat`. `null` = unparseable. */
  amountZat: number | null
  /** Spendable balance in zatoshis. `null` = we could not read it. */
  availableZat: number | null
  /** The fee estimate this screen applies. */
  feeZat: number
  /** Memo over the 512-byte limit. */
  memoOver?: boolean
  /** The spendable balance split by shielded pool, when the backend reported it (#427).
   *
   *  Omitted means the split is not known, which happens only against a helper predating the
   *  Ironwood pool - a vault that is single-pool by construction. So omission is not the usual
   *  "I do not know": there is nothing to cross. */
  pools?: { orchard: number; ironwood: number }
}

/**
 * Order is deliberate: it decides which field a member is sent to fix.
 *
 * The memo comes first because it is fixable without re-reading any figure. The amount comes
 * before the balance because naming a balance problem while the amount is unreadable points at
 * the wrong field. `no-funds` is separated from `over-balance` because at zero spendable the
 * "lower the amount" remedy is impossible - the honest answer is that there is nothing to spend.
 */
/**
 * The i18n key explaining a block, or `null` when the screen owns the wording.
 *
 * `memo` and `over-balance` already have screen-specific copy (a byte counter, and a
 * payment-vs-payroll phrasing), so they are left alone. The three returned here are the ones the
 * gate started blocking on when it was made to fail closed - without them a member would meet a
 * disabled button and no reason, which for the comma-decimal case is worse than the old behaviour
 * of enabling the button and failing afterwards.
 */
export function blockMessageKey(b: ProposeBlock): string | null {
  switch (b) {
    case 'amount':
      return 'money.blockAmount'
    case 'balance-unknown':
      return 'money.blockBalanceUnknown'
    case 'no-funds':
      return 'money.blockNoFunds'
    case 'crosses-pools':
      return 'money.blockCrossesPools'
    default:
      return null
  }
}

/**
 * The pool split as `proposeBlock` wants it, read off a balance.
 *
 * Lives here, with the rule that consumes it, so the two propose screens cannot derive it two ways -
 * which is the failure this file already exists to prevent (the over-balance test lived inline in
 * both screens and failed open in both).
 *
 * `undefined` when the backend reported no Ironwood figure at all. That is an older helper, from
 * before the pool existed, so the vault holds one pool and there is nothing to cross - the absence
 * is information, not ignorance.
 */
export function poolsOf(
  b: { orchard_spendable_zat?: number; ironwood_spendable_zat?: number } | null | undefined,
): ProposeInput['pools'] {
  if (!b || typeof b.ironwood_spendable_zat !== 'number') return undefined
  return { orchard: b.orchard_spendable_zat ?? 0, ironwood: b.ironwood_spendable_zat }
}

export function proposeBlock(input: ProposeInput): ProposeBlock {
  const { amountZat, availableZat, feeZat, memoOver = false, pools } = input

  if (memoOver) return 'memo'
  if (amountZat === null || amountZat <= 0) return 'amount'
  if (availableZat === null) return 'balance-unknown'
  if (availableZat === 0) return 'no-funds'
  if (availableZat - amountZat - feeZat < 0) return 'over-balance'

  // #427. `availableZat` is the sum of the two shielded pools, and the sum overstates what ONE
  // payment can move. The note selector spends a single pool whenever one covers amount+fee, and
  // accumulates across pools only when neither does - and a transaction spending from both is
  // refused by the signing bridge. So the amounts that break are exactly those greater than the
  // larger pool and no greater than the total: accepted here, approved by a quorum, dead at signing.
  //
  // Gating on the larger pool is enough on its own. If amount+fee fits inside one pool, some single
  // pool covers it, so the selector never needs to cross. Nothing has to constrain the builder -
  // which matters, because the single-payment path builds through an external binary that takes no
  // pool argument.
  //
  // This is a product limit, not a protocol one (§6.14): the funds are real and spendable, just not
  // in one payment, which is what the message has to say. Two payments move them.
  if (pools) {
    const larger = Math.max(pools.orchard, pools.ironwood)
    if (amountZat + feeZat > larger) return 'crosses-pools'
  }

  return null
}
