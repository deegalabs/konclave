import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { codeAt } from './source-scan'

// Three defects from #282 that survived a month, each one a money control that misleads rather
// than fails. The issue prescribed a whole derived money model; most of what that was for has
// since been fixed piecemeal - the overspend guard fails closed, `no-funds` is distinguished from
// `over-balance`, and the dropped balance fields are back - so what remains is these, and they are
// held here rather than by a rewrite nobody needs.
const SRC = new URL('.', import.meta.url).pathname
const codeOf = (f: string) => codeAt(join(SRC, f)) // comments excluded, by the parser

describe('a blocked money screen watches the thing that blocked it', () => {
  it('the payment screen refreshes its balance', () => {
    // It read the balance once, at mount. Every block it can show - no funds, not enough, unknown
    // - was therefore permanent until the member thought to reload, and nothing suggested they
    // should. Someone waiting on a deposit sat in front of a button that would have worked.
    const code = codeOf('screens/NewPayment.tsx')
    expect(code, 'NewPayment stopped polling: a stale zero blocks the member until they reload')
      .toMatch(/usePoll\(/)
    // The balance itself refreshes in the hook both money screens share (useVaultBalance polls).
    expect(code, 'the screen no longer reads the balance through the refreshing hook').toMatch(/= useVaultBalance\(\)/)
    expect(codeOf('useVaultBalance.ts')).toMatch(/usePoll\(tick, 12_000\)/)
  })

  it('the fraction buttons are dead when there is nothing to take a fraction of', () => {
    // At zero spendable these stayed enabled and did nothing: `setFraction` computed zero (or
    // minus the fee) and set no amount. A control that answers a click with silence is worse than
    // one that is visibly unavailable.
    const code = codeOf('screens/NewPayment.tsx')
    expect(code, 'the %/Max buttons are gated on the balance being KNOWN again, not on it being spendable')
      .not.toMatch(/payamt-max" disabled=\{availableZat == null\}/)
    expect(code).toMatch(/canTakeFraction/)
  })

  it('the confirming amount is not added to a total that already contains it', () => {
    // "0.0006" as the headline with "+0.0006 confirming" beneath it reads as 0.0012 - the same
    // money twice, on the balance card. The headline is the TOTAL.
    const code = codeOf('screens/Dashboard.tsx')
    const line = code.split('\n').find((l) => l.includes("t('dashboard.confirming'"))
    expect(line, 'Dashboard no longer renders the confirming line').toBeTruthy()
    expect(line, 'the leading + is back: the confirming amount is being added to a total that includes it')
      .not.toMatch(/\+\$\{/)
  })
})

describe('an amount field is read by one rule on every screen (Daniel, 2026-10-21)', () => {
  // The pt-BR pay screen said "Use ponto no decimal" for 0,0005. What the member typed stays in the
  // field as typed (the phone's pt-BR keypad has only the comma) and is read by `typedAmountZat`,
  // the one reader, which also refuses an ambiguous amount (1.500 / 1,500). No screen calls the
  // strict parser on a typed field, because the parser alone would read 1.500 as 1.5.
  const screens = ['screens/NewPayment.tsx', 'screens/NewPayroll.tsx', 'screens/Receive.tsx']

  it('no screen parses a typed amount without the one reader', () => {
    for (const f of screens) expect(codeOf(f), f).not.toMatch(/parseZecToZat\(/)
  })

  it('the payment screen reads, previews and sends through it, and leaves the field as typed', () => {
    const code = codeOf('screens/NewPayment.tsx')
    expect(code).toMatch(/typedAmountZat\(value\)/)
    expect(code).toMatch(/value_zec: amountTyped\(value\)/)
    expect(code, 'the field rewrites what the member types').not.toMatch(/setValue\(amountTyped/)
    expect(code, 'the dollar preview parses the raw text').not.toMatch(/zecToUsd\(value/)
    expect(code, 'the pays row shows the raw text').not.toMatch(/\{value \|\| '-'\} ZEC/)
    // The confirming preview shows the amount as it will be proposed.
    expect(code).toMatch(/amountZat != null \? fmtZecExact\(amountZat \/ 1e8\)/)
    expect(code).toMatch(/amountAmbiguous: amountAmbiguous\(value\)/)
  })

  it('every payroll row is read through it, and an ambiguous row says so', () => {
    const code = codeOf('screens/NewPayroll.tsx')
    expect(code).toMatch(/typedAmountZat\(r\.value\)/)
    expect(code).toMatch(/value_zec: amountTyped\(r\.value\)/)
    expect(code).toMatch(/if \(amountAmbiguous\(r\.value\)\) return 'money\.blockAmountAmbiguous'/)
  })

  it('the receive request is read through it, and an ambiguous amount says so', () => {
    const code = codeOf('screens/Receive.tsx')
    expect(code).toMatch(/typedAmountZat\(amount\)/)
    expect(code).toMatch(/amountAmbiguous\(amount\) && .*t\('money\.blockAmountAmbiguous'\)/)
    expect(code, 'Receive normalises the comma by itself again').not.toMatch(/replace\(',', '\.'\)/)
  })

  it('both languages carry the approved sentences', async () => {
    const { ptBR } = await import('./i18n/pt-BR')
    const { en } = await import('./i18n/en')
    expect(ptBR['money.blockAmount']).toBe('Use um só separador decimal. Por exemplo, digite 1,5.')
    expect(en['money.blockAmount']).toBe('Use a single decimal point. For example, type 1.5.')
    expect(ptBR['money.blockAmountAmbiguous']).toBe('Esse valor é ambíguo. Digite 1,5 ou 1500.')
    expect(en['money.blockAmountAmbiguous']).toBe('That amount is ambiguous. Type 1.5 or 1500.')
  })
})
