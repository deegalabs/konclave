import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { freeZatOf, reservedZatOf } from './balance-parts'
import type { Proposal } from './api'
import type { FeeEstimator } from './fee-estimate'
import { proposalCostZat } from './proposal-cost'

// The Dashboard and the payment screen used different words for "available", and the screen that
// CREATES payments held the more permissive one: `spendable`, with nothing subtracted. So the
// Dashboard could say the vault cannot pay while the payment screen accepted the amount, carried it
// to a quorum, and let it die at signing - or killed the earlier proposal that had the funds first.
// An injected estimator with a per-destination part, so a test can tell estimate(1) from estimate(N).
// No number of the real fee rule is typed here: every expectation is built from the estimator.
const est: FeeEstimator = (n) => 10 * (n + 2)
const p = (state: string, zat: number, destinations: number | null = 1, kind: Proposal['kind'] = 'payment'): Proposal =>
  ({ id: String(zat), state, kind, value_zat: zat, destinations } as unknown as Proposal)
const cost = (zat: number, n = 1) => zat + est(n)!

describe('what a new payment may draw on', () => {
  it('subtracts every proposal that can still move, with its fee estimate', () => {
    // `isOpen` is the rule, and its own doc calls these "still consuming vault funds".
    expect(reservedZatOf([p('awaiting', 100), p('ready', 50)], est)).toBe(cost(100) + cost(50))
  })

  it('an open N-line payroll reserves its value plus the estimate for N, not for one', () => {
    const roll = p('awaiting', 10_000, 7, 'payroll')
    expect(reservedZatOf([roll], est)).toBe(cost(10_000, 7))
    expect(reservedZatOf([roll], est)).not.toBe(cost(10_000, 1))
  })

  it('subtracts nothing for a proposal that has stopped', () => {
    for (const state of ['sent', 'confirmed', 'refused', 'expired', 'cancelled', 'superseded']) {
      expect(reservedZatOf([p(state, 100)], est), `${state} should release its funds`).toBe(0)
    }
  })

  it('is spendable minus what is held, fee estimate included', () => {
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 800 }, [p('awaiting', 300)], est)).toBe(800 - cost(300))
  })

  it('never goes below zero when more is committed than the vault can spend', () => {
    // Over-commitment is possible - a proposal made before funds moved - and a negative "free"
    // would flow into an amount field.
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 400 }, [p('awaiting', 900)], est)).toBe(0)
  })

  it('is null, not zero, when the balance is unknown', () => {
    // The difference the whole guard rests on: zero reads as "the vault is empty" and sends the
    // member looking for money that is there. Unknown has to stay unknown.
    expect(freeZatOf(null, [], est)).toBeNull()
    expect(freeZatOf({ total_zat: null }, [], est)).toBeNull()
  })

  it('treats confirming funds as not yet drawable', () => {
    // 1000 held, 400 confirmed: a payment can draw on 400, whatever the headline says.
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 400 }, [], est)).toBe(400)
  })

  it('an open-proposal list not read yet is unknown, never "nothing reserved"', () => {
    expect(reservedZatOf(null, est)).toBeNull()
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 400 }, null, est)).toBeNull()
  })

  it('a proposal whose deadline passed on this clock holds nothing', () => {
    const late = { ...p('awaiting', 100), expiry_unix: 1 } as Proposal
    expect(reservedZatOf([late, p('ready', 50)], est)).toBe(cost(50))
  })

  it('fails closed: an unknown estimate or unread destinations make the reservation unknown', () => {
    expect(reservedZatOf([p('awaiting', 100)], null)).toBeNull()
    expect(reservedZatOf([p('awaiting', 100), p('ready', 5, null, 'payroll')], est)).toBeNull()
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 800 }, [p('awaiting', 300)], null)).toBeNull()
  })

  it('with no open proposal the answer is 0 whatever the estimator is', () => {
    expect(reservedZatOf([], null)).toBe(0)
    expect(reservedZatOf([p('sent', 100)], null)).toBe(0)
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 400 }, [], null)).toBe(400)
  })

  it('a second payment that fits only without the first one\'s fee is refused as reserved (#1017)', () => {
    // Vault of 1000 spendable, one open payment of 300. Without its fee the second may take 700;
    // with it, only 700 - est(1). Ask for a value that needs that room plus the second one's own fee.
    const bal = { total_zat: 1000, spendable_zat: 1000 }
    const open = [p('awaiting', 300)]
    const free = freeZatOf(bal, open, est)!
    const feeZat = est(1)!
    const amountZat = 700 - feeZat // fits if the first proposal's fee were not counted
    expect(amountZat + feeZat).toBeLessThanOrEqual(1000 - 300)
    expect(proposeBlock({ amountZat, availableZat: free, feeZat, reservedZat: reservedZatOf(open, est) })).toBe('reserved')
    // And with the fee left out of the reservation it would have been accepted: the bug.
    expect(proposeBlock({ amountZat, availableZat: 700, feeZat, reservedZat: 300 })).toBeNull()
  })

  it('what the guard admits grows the reservation by exactly proposalCostZat of the proposal made', () => {
    for (const [n, kind] of [[1, 'payment'], [4, 'payroll']] as const) {
      const made = p('awaiting', 5_000, n, kind)
      expect(reservedZatOf([made], est)).toBe(proposalCostZat(made, est))
    }
  })
})

import { proposeBlock } from './propose-guard'

describe('the guard says WHICH shortage it is', () => {
  const base = { feeZat: 15000, amountZat: 100_000 }

  it('calls it reserved when the vault holds enough and a proposal has it', () => {
    // 100k + fee would fit in 200k, but only 50k is free. The member is not short - a colleague
    // got there first, and that is a different thing to do something about.
    expect(proposeBlock({ ...base, availableZat: 50_000, reservedZat: 150_000 })).toBe('reserved')
  })

  it('calls it over-balance when even the held funds would not cover it', () => {
    // 100k + fee against 60k total: no proposal resolving changes this answer.
    expect(proposeBlock({ ...base, availableZat: 50_000, reservedZat: 10_000 })).toBe('over-balance')
  })

  it('distinguishes an empty vault from a fully committed one', () => {
    expect(proposeBlock({ ...base, availableZat: 0, reservedZat: 0 })).toBe('no-funds')
    expect(proposeBlock({ ...base, availableZat: 0, reservedZat: 500_000 })).toBe('reserved')
  })

  it('still fails closed on an unknown balance, whatever is reserved', () => {
    // The property that must survive every change to this function.
    expect(proposeBlock({ ...base, availableZat: null, reservedZat: 0 })).toBe('balance-unknown')
    expect(proposeBlock({ ...base, availableZat: null, reservedZat: 999 })).toBe('balance-unknown')
  })

  it('is unchanged where nothing is reserved', () => {
    // Callers without a ledger omit `reservedZat`; they must behave exactly as before.
    expect(proposeBlock({ ...base, availableZat: 0 })).toBe('no-funds')
    expect(proposeBlock({ ...base, availableZat: 50_000 })).toBe('over-balance')
    expect(proposeBlock({ ...base, availableZat: 500_000 })).toBeNull()
  })
})

import { join } from 'node:path'
import { blockMessageKey } from './propose-guard'
import { codeAt } from './source-scan'

describe('one notion of free funds, held in one place', () => {
  const SRC = fileURLToPath(new URL('.', import.meta.url))
  const codeOf = (f: string) => codeAt(join(SRC, f)) // comments excluded, by the parser

  it('the payment screen derives what it can send instead of reading spendable', () => {
    // The drift this closes: the Dashboard's `canPay` subtracted open proposals, the payment
    // screen did not, and the permissive one was the screen that CREATES payments.
    const code = codeOf('screens/NewPayment.tsx')
    expect(code, 'NewPayment is back to offering raw spendable').not.toMatch(/setAvailable\(b\.spendable_zec/)
    expect(code, 'it no longer derives from the shared function').toMatch(/freeZatOf\(/)
  })

  it('the reserved block has a message, and it is not the short-of-funds one', () => {
    // Telling a member "not enough" when a colleague's proposal holds the difference sends them
    // to find money they already have.
    const key = blockMessageKey('reserved')
    expect(key, 'the reserved block fell through to no message').toBeTruthy()
    expect(key).not.toBe(blockMessageKey('no-funds'))
    expect(key).not.toBe(blockMessageKey('balance-unknown'))
  })

  it('its copy shows the arithmetic and names who is holding it, in both languages', () => {
    // Reservation is a product lock, not the network refusing (§6.14). A bare "not enough" hides
    // the one thing the member can act on.
    for (const loc of ['en.ts', 'pt-BR.ts']) {
      const line = codeAt(join(SRC, 'i18n', loc))
        .split('\n').find((l) => l.includes("'money.blockReserved'"))
      expect(line, `${loc} has no reserved message`).toBeTruthy()
      for (const token of ['{reserved}', '{free}', '{held}']) {
        expect(line, `${loc} drops ${token}: the member cannot see the arithmetic`).toContain(token)
      }
    }
  })
})
