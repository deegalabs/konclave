import { describe, expect, it } from 'vitest'
import { confirmingZatOf, shortfallIsConfirming } from './balance-parts'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* 4.2 (#293, #352): Payroll checks whether it fits the same way Pay does, from the same file.
 *
 * Pay subtracted what open proposals hold (reservedZatOf / freeZatOf, #293) and Payroll did not: it
 * read `spendable_zat` on its own, so two 0.006 payrolls against 0.01 spendable both validated and
 * the second died at build. And neither screen could say the funds were merely confirming (#352):
 * "exceeds the vault balance" was the only word, even when the vault held the amount and the wallet
 * was waiting on confirmations.
 *
 * The trap #352 names: `balance.pending_zat` is optional on the type and never filled on the web
 * path, so code reading it type-checks and does nothing. Confirming is DERIVED, total minus
 * spendable, in integers, the way the Dashboard does it. */

describe('confirming funds are derived, never read', () => {
  it('is total minus spendable, in whole zatoshi', () => {
    expect(confirmingZatOf({ total_zat: 1_000_000, spendable_zat: 400_000 })).toBe(600_000)
  })
  it('is zero when everything is spendable, and never negative', () => {
    expect(confirmingZatOf({ total_zat: 500, spendable_zat: 500 })).toBe(0)
    expect(confirmingZatOf({ total_zat: 500, spendable_zat: 900 })).toBe(0)
  })
  it('is null, not zero, when the balance is unknown', () => {
    expect(confirmingZatOf(null)).toBeNull()
    expect(confirmingZatOf({ total_zat: undefined, spendable_zat: 5 })).toBeNull()
  })
  it('ignores pending_zat, which the web path never fills', () => {
    const withPending = { total_zat: 1000, spendable_zat: 1000, pending_zat: 999 } // as the type allows, and the web never fills
    expect(confirmingZatOf(withPending)).toBe(0)
  })
})

describe('the shortfall is "confirming" only when the confirmed-later funds would cover it', () => {
  const bal = { total_zat: 1_000_000, spendable_zat: 100_000 } // 0.009 confirming
  it('says so when amount + fee fits once the confirming part lands', () => {
    expect(shortfallIsConfirming(bal, 0, 500_000, 15_000)).toBe(true)
  })
  it('does not when it would not fit even then', () => {
    expect(shortfallIsConfirming(bal, 0, 990_000, 15_000)).toBe(false)
  })
  it('counts what open proposals hold against it', () => {
    expect(shortfallIsConfirming(bal, 500_000, 500_000, 15_000)).toBe(false)
    expect(shortfallIsConfirming(bal, 100_000, 500_000, 15_000)).toBe(true)
  })
  it('is false when nothing is confirming, whatever the shortfall', () => {
    expect(shortfallIsConfirming({ total_zat: 100_000, spendable_zat: 100_000 }, 0, 500_000, 15_000)).toBe(false)
  })
  it('is false on an unknown balance or amount', () => {
    expect(shortfallIsConfirming(null, 0, 500_000, 15_000)).toBe(false)
    expect(shortfallIsConfirming(bal, 0, null, 15_000)).toBe(false)
  })
})

describe('Payroll fits the way Pay does, from the one file', () => {
  const payroll = codeOf('screens/NewPayroll.tsx')
  const pay = codeOf('screens/NewPayment.tsx')

  it('derives what it can draw on instead of reading spendable', () => {
    expect(payroll, 'Payroll still reads spendable on its own').not.toMatch(/bal\.spendable_zat \?\? bal\.total_zat/)
    expect(payroll).toMatch(/freeZatOf\(/)
    expect(payroll).toMatch(/reservedZatOf\(/)
    expect(payroll).toMatch(/proposeBlock\(\{[^}]*reservedZat/)
  })
  it('reads the open proposals, and keeps reading them on the shared cadence', () => {
    expect(payroll).toMatch(/getProposals\(\)/)
    expect(payroll).toMatch(/usePoll\(/)
  })
  it('shows the arithmetic of a reservation, like Pay', () => {
    expect(payroll).toMatch(/free: fmtZecExact/)
    expect(payroll).toMatch(/reserved: fmtZecExact/)
    expect(payroll).toMatch(/held: /)
  })
  for (const [name, code] of [['Pay', pay], ['Payroll', payroll]] as const) {
    it(`${name} says the funds are confirming when that is the whole shortfall`, () => {
      expect(code).toMatch(/shortfallIsConfirming\(/)
      expect(code).toMatch(/t\('money\.blockConfirming'/)
      expect(code, 'nothing may read the never-filled field').not.toMatch(/pending_zat/)
    })
  }
  it('the sentence exists in both languages, with the amount and no confirmation count', () => {
    // The count is 10 for untrusted notes and 3 for the vault's own change (CONFIRMATIONS_* in
    // api.ts); a number in the copy would be a third place that says it, and wrong half the time.
    for (const d of [en, ptBR]) {
      expect(d['money.blockConfirming']).toContain('{confirming}')
      expect(d['money.blockConfirming']).not.toMatch(/\d/)
    }
  })
  for (const [name, code, id] of [['Pay', pay, 'pay-block'], ['Payroll', payroll, 'payroll-block']] as const) {
    it(`${name} keeps the block in one live region the button points at`, () => {
      expect(code).toMatch(new RegExp(`<div role="status" id="${id}">`))
      expect(code).toMatch(new RegExp(`blockMsg \\? '${id}'`))
    })
    it(`${name} keeps the last list of open proposals when a poll fails`, () => {
      expect(code).toMatch(/getProposals\(\)\.then\(\(ps\) => \{ if \(ps\) setOpenProps\(ps\) \}\)/)
      expect(code).not.toMatch(/then\(setOpenProps\)/)
    })
  }
})
