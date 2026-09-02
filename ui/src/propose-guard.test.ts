import { describe, it, expect } from 'vitest'
import { proposeBlock } from './propose-guard'

// The submit gate for a payment or a payroll, as a pure rule.
//
// It lived inline in two screens and FAILED OPEN in both: whenever a figure could not be parsed,
// the "over balance" test evaluated to false and the screen read that as "all clear". Two separate
// inputs reached that same hole - a balance the app could not read (`available` is `'-'`), and an
// amount the app could not parse (a comma decimal, which `parseZecToZat` rejects). Money must fail
// CLOSED: "I do not know" is not "go ahead".

const FEE = 15_000
const ZEC = 100_000_000

describe('proposeBlock - money fails closed', () => {
  it('lets a fundable payment through', () => {
    expect(proposeBlock({ amountZat: ZEC, availableZat: 2 * ZEC, feeZat: FEE })).toBeNull()
  })

  it('blocks when amount + fee exceeds what is spendable', () => {
    expect(proposeBlock({ amountZat: 2 * ZEC, availableZat: ZEC, feeZat: FEE })).toBe('over-balance')
  })

  it('blocks by a margin of one zatoshi, and allows the exact-fit payment', () => {
    const available = ZEC
    expect(proposeBlock({ amountZat: available - FEE, availableZat: available, feeZat: FEE })).toBeNull()
    expect(proposeBlock({ amountZat: available - FEE + 1, availableZat: available, feeZat: FEE })).toBe('over-balance')
  })

  // THE FIRST LIVE DEFECT. `available` is `'-'` whenever getBalance() fails, so the parsed balance
  // is null. The screens computed `afterZat = null` and then `overBalance = false`, i.e. a failed
  // balance read silently disabled the guard that exists to stop a dead-end proposal.
  it('blocks when the balance could not be read, instead of assuming it is fine', () => {
    expect(proposeBlock({ amountZat: ZEC, availableZat: null, feeZat: FEE })).toBe('balance-unknown')
  })

  // THE SECOND LIVE DEFECT. `parseZecToZat` rejects a comma decimal, so a pt-BR user typing "0,5"
  // produced a null amount - and the screens' own submit check used a LOOSER parser
  // (`parseFloat(value.replace(',', '.')) > 0`) which accepted it. The button enabled for an
  // amount the rest of the code could not read.
  it('blocks an amount it cannot parse, rather than enabling submit', () => {
    expect(proposeBlock({ amountZat: null, availableZat: 2 * ZEC, feeZat: FEE })).toBe('amount')
  })

  it('blocks a zero or negative amount', () => {
    expect(proposeBlock({ amountZat: 0, availableZat: 2 * ZEC, feeZat: FEE })).toBe('amount')
    expect(proposeBlock({ amountZat: -1, availableZat: 2 * ZEC, feeZat: FEE })).toBe('amount')
  })

  it('reports the memo first, because it is the one the writer can fix without re-reading figures', () => {
    expect(proposeBlock({ amountZat: null, availableZat: null, feeZat: FEE, memoOver: true })).toBe('memo')
  })

  // Order matters for the message a member is shown: naming a balance problem while the amount is
  // unreadable would send them to fix the wrong field.
  it('names the unreadable amount before the unknown balance', () => {
    expect(proposeBlock({ amountZat: null, availableZat: null, feeZat: FEE })).toBe('amount')
  })

  it('a zero-spendable vault blocks on the balance, not on "lower the amount"', () => {
    // #282: at spendable 0 every amount tripped `over-balance`, whose remedy ("lower the amount")
    // is impossible. The honest answer is that there is nothing to spend.
    expect(proposeBlock({ amountZat: ZEC, availableZat: 0, feeZat: FEE })).toBe('no-funds')
  })
})
