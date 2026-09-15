import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { proposeBlock, poolsOf } from './propose-guard'

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

describe('proposeBlock: the sum of two pools is not what one payment can move (#427)', () => {
  // The vault holds 0.6 in one pool and 0.5 in the other. `spendable` says 1.1.
  const SPLIT = { orchard: 60_000_000, ironwood: 50_000_000 }
  const SUM = SPLIT.orchard + SPLIT.ironwood

  it('blocks the amounts that cross pools: above the larger pool, within the total', () => {
    // This is the whole defect. The note selector spends ONE pool when one covers amount+fee and
    // crosses only when neither does, and the signing bridge refuses a crossed transaction. So this
    // amount used to be accepted, sent to a quorum for approval, and die at signing.
    expect(proposeBlock({ amountZat: 70_000_000, availableZat: SUM, feeZat: FEE, pools: SPLIT }))
      .toBe('crosses-pools')
  })

  it('allows an amount the larger pool covers on its own', () => {
    expect(proposeBlock({ amountZat: 50_000_000, availableZat: SUM, feeZat: FEE, pools: SPLIT }))
      .toBe(null)
  })

  it('counts the fee, because the selector does', () => {
    // Exactly the larger pool, so the fee is what pushes it over. Off by one fee is off by a failed
    // payment.
    expect(proposeBlock({ amountZat: SPLIT.orchard, availableZat: SUM, feeZat: FEE, pools: SPLIT }))
      .toBe('crosses-pools')
    expect(proposeBlock({ amountZat: SPLIT.orchard - FEE, availableZat: SUM, feeZat: FEE, pools: SPLIT }))
      .toBe(null)
  })

  it('still reports over-balance when the amount exceeds the TOTAL, not the pool split', () => {
    // The two blocks have different remedies: "send it as two payments" versus "you do not have it".
    // Telling a member to split a payment they cannot afford is a worse message than the old one.
    expect(proposeBlock({ amountZat: SUM + ZEC, availableZat: SUM, feeZat: FEE, pools: SPLIT }))
      .toBe('over-balance')
  })

  it('a single-pool vault is never blocked by this', () => {
    // Every vault measured in production is single-pool. If this rule touched them it would be a
    // worse defect than the one it closes.
    const ONLY_IRONWOOD = { orchard: 0, ironwood: SUM }
    expect(proposeBlock({ amountZat: SUM - FEE, availableZat: SUM, feeZat: FEE, pools: ONLY_IRONWOOD }))
      .toBe(null)
  })

  it('and a backend that reports no split at all is not blocked either', () => {
    // No Ironwood figure means a helper from before the pool existed, so the vault is single-pool by
    // construction. Unlike the other unknowns in this file, this absence is information: there is
    // nothing to cross. Blocking here would break every vault to protect a case that cannot occur.
    expect(proposeBlock({ amountZat: SUM - FEE, availableZat: SUM, feeZat: FEE })).toBe(null)
  })
})

describe('poolsOf: one derivation, not one per screen (#427)', () => {
  it('reads the split off a balance', () => {
    expect(poolsOf({ orchard_spendable_zat: 7, ironwood_spendable_zat: 11 }))
      .toEqual({ orchard: 7, ironwood: 11 })
  })

  it('treats a missing Ironwood figure as "no split to speak of", not as zero', () => {
    // Zero would be a LIE that blocks: it would say the vault holds everything in Orchard and
    // nothing in Ironwood, which is indistinguishable from a real 100%-Orchard vault only by luck.
    expect(poolsOf({ orchard_spendable_zat: 7 })).toBeUndefined()
    expect(poolsOf(null)).toBeUndefined()
    expect(poolsOf(undefined)).toBeUndefined()
  })

  it('defaults a missing Orchard figure to zero, which is safe in the other direction', () => {
    expect(poolsOf({ ironwood_spendable_zat: 11 })).toEqual({ orchard: 0, ironwood: 11 })
  })
})

describe('every screen that asks the gate also tells it about the pools (#427)', () => {
  // `pools` is OPTIONAL, because a backend can legitimately not report a split - so a screen that
  // forgets it COMPILES, and silently goes back to gating on the sum. That is the shape this repo
  // produces most: one rule, two callers, one of them updated. #468 answered the same problem the
  // same way, and the reason it is a source scan rather than a type is that the optionality is real.
  //
  // Test files are excluded deliberately: most of them exercise the non-pool branches on purpose,
  // and counting them would rebuild the blind spot this is meant to close.
  const SRC = new URL('.', import.meta.url).pathname

  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { sources(p, out); continue }
      if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
    }
    return out
  }

  it('no production caller of proposeBlock omits pools', () => {
    const offenders = sources(SRC)
      .filter((p) => !p.endsWith('propose-guard.ts'))
      .filter((p) => {
        const src = readFileSync(p, 'utf8')
        // Every `proposeBlock({ ... })` in the file must name `pools` inside its own braces.
        const calls = src.match(/proposeBlock\(\{[^}]*\}/g) ?? []
        return calls.some((c) => !c.includes('pools'))
      })
      .map((p) => relative(SRC, p))

    expect(
      offenders,
      `these gate on the SUM of both pools, which one payment cannot always spend: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('and at least one screen actually asks it, so the rule is reachable', () => {
    // The #468 lesson: a rule the product never invokes ships, passes its tests, and does nothing.
    const callers = sources(SRC).filter((p) => /proposeBlock\(/.test(readFileSync(p, 'utf8')))
    expect(callers.length, 'no screen calls proposeBlock at all').toBeGreaterThan(0)
  })
})

describe('the fee a member is SHOWN is the fee they are BLOCKED by (#427 follow-up)', () => {
  // Found by a member on a real vault on 2026-09-15, which is the only reason it was found at all.
  // The screen said "Estimated fee 0.0001 ZEC" from a hardcoded i18n string while the gate
  // subtracted 15000 (0.00015). So a vault holding exactly the announced fee was told it could not
  // afford a payment that the arithmetic printed beside it said it could, and the member reasonably
  // concluded the gate was broken rather than the copy.
  //
  // The number now comes from SINGLE_PAYMENT_FEE_ZAT in both places. This asserts the copy cannot
  // hardcode it again, which is how it drifted in the first place: a fee in prose is a fee nobody
  // updates when the constant moves.
  const SRC = new URL('.', import.meta.url).pathname

  it('the fee copy is a placeholder, never a number', () => {
    for (const locale of ['i18n/en.ts', 'i18n/pt-BR.ts']) {
      const line = readFileSync(join(SRC, locale), 'utf8')
        .split('\n')
        .find((l) => l.includes('payment.feeEstimate'))
      expect(line, `${locale} has no payment.feeEstimate`).toBeTruthy()
      expect(line, `${locale} must interpolate the fee`).toContain('{fee}')
      expect(
        /\d+\.\d+/.test(line ?? ''),
        `${locale} hardcodes a fee amount in prose: ${line}`,
      ).toBe(false)
    }
  })

  it('and the payment screen subtracts that same constant', () => {
    const screen = readFileSync(join(SRC, 'screens/NewPayment.tsx'), 'utf8')
    expect(screen, 'the gate must use the shared constant').toContain('SINGLE_PAYMENT_FEE_ZAT')
    expect(
      /const feeZat = \d+/.test(screen),
      'a bare numeric fee is back, and the copy will not follow it',
    ).toBe(false)
  })
})
