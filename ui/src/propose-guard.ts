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
    default:
      return null
  }
}

export function proposeBlock(input: ProposeInput): ProposeBlock {
  const { amountZat, availableZat, feeZat, memoOver = false } = input

  if (memoOver) return 'memo'
  if (amountZat === null || amountZat <= 0) return 'amount'
  if (availableZat === null) return 'balance-unknown'
  if (availableZat === 0) return 'no-funds'
  if (availableZat - amountZat - feeZat < 0) return 'over-balance'
  return null
}
