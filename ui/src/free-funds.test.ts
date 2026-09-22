import { describe, expect, it } from 'vitest'
import { freeZatOf, reservedZatOf } from './balance-parts'
import type { Proposal } from './api'

// The Dashboard and the payment screen used different words for "available", and the screen that
// CREATES payments held the more permissive one: `spendable`, with nothing subtracted. So the
// Dashboard could say the vault cannot pay while the payment screen accepted the amount, carried it
// to a quorum, and let it die at signing - or killed the earlier proposal that had the funds first.
const p = (state: string, zat: number): Proposal =>
  ({ id: String(zat), state, value_zat: zat } as unknown as Proposal)

describe('what a new payment may draw on', () => {
  it('subtracts every proposal that can still move', () => {
    // `isOpen` is the rule, and its own doc calls these "still consuming vault funds".
    expect(reservedZatOf([p('awaiting', 100), p('ready', 50)])).toBe(150)
  })

  it('subtracts nothing for a proposal that has stopped', () => {
    for (const state of ['sent', 'confirmed', 'refused', 'expired', 'cancelled', 'superseded']) {
      expect(reservedZatOf([p(state, 100)]), `${state} should release its funds`).toBe(0)
    }
  })

  it('is spendable minus what is held', () => {
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 800 }, [p('awaiting', 300)])).toBe(500)
  })

  it('never goes below zero when more is committed than the vault can spend', () => {
    // Over-commitment is possible - a proposal made before funds moved - and a negative "free"
    // would flow into an amount field.
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 400 }, [p('awaiting', 900)])).toBe(0)
  })

  it('is null, not zero, when the balance is unknown', () => {
    // The difference the whole guard rests on: zero reads as "the vault is empty" and sends the
    // member looking for money that is there. Unknown has to stay unknown.
    expect(freeZatOf(null, [])).toBeNull()
    expect(freeZatOf({ total_zat: null }, [])).toBeNull()
  })

  it('treats confirming funds as not yet drawable', () => {
    // 1000 held, 400 confirmed: a payment can draw on 400, whatever the headline says.
    expect(freeZatOf({ total_zat: 1000, spendable_zat: 400 }, null)).toBe(400)
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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockMessageKey } from './propose-guard'

describe('one notion of free funds, held in one place', () => {
  const SRC = new URL('.', import.meta.url).pathname
  const codeOf = (f: string) =>
    readFileSync(join(SRC, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join('\n')

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
      const line = readFileSync(join(SRC, 'i18n', loc), 'utf8')
        .split('\n').find((l) => l.includes("'money.blockReserved'"))
      expect(line, `${loc} has no reserved message`).toBeTruthy()
      for (const token of ['{reserved}', '{free}', '{held}']) {
        expect(line, `${loc} drops ${token}: the member cannot see the arithmetic`).toContain(token)
      }
    }
  })
})
