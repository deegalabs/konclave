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

describe('an amount field takes the decimal separator the member types', () => {
  // The pt-BR pay screen said "Use ponto no decimal" for 0,0005 while showing every amount with a
  // comma. What the member typed stays in the field as typed (the phone's pt-BR keypad has only the
  // comma); it is read through the one function wherever it is parsed or sent, so the gate, the
  // preview and the proposal read the same amount.
  it('the payment screen reads and sends the amount through amountTyped, and leaves the field as typed', () => {
    const code = codeOf('screens/NewPayment.tsx')
    expect(code).toMatch(/parseZecToZat\(amountTyped\(value\)\)/)
    expect(code).toMatch(/value_zec: amountTyped\(value\)/)
    expect(code, 'the raw amount is parsed somewhere without amountTyped').not.toMatch(/parseZecToZat\(value\)/)
    expect(code, 'the field rewrites what the member types').not.toMatch(/setValue\(amountTyped/)
    // parseFloat('0,5') is 0: the dollar preview has to read the same parsed amount, not the raw text.
    expect(code, 'the dollar preview parses the raw text').not.toMatch(/zecToUsd\(value/)
    // The confirming preview shows what the proposal will carry, not the raw text: '1,000' typed in
    // English is read as 1 ZEC, and the member must see that before proposing.
    expect(code, 'the pays row shows the raw text').not.toMatch(/\{value \|\| '-'\} ZEC/)
    expect(code).toMatch(/amountZat != null \? fmtZecExact\(amountZat \/ 1e8\)/)
  })

  it('every payroll row is read and sent through amountTyped', () => {
    const code = codeOf('screens/NewPayroll.tsx')
    expect(code.match(/parseZecToZat\(amountTyped\(r\.value\)\)/g)?.length).toBe(2)
    expect(code).toMatch(/value_zec: amountTyped\(r\.value\)/)
    expect(code).not.toMatch(/parseZecToZat\(r\.value\)/)
  })

  it('the refusal no longer tells a pt-BR member to type a dot', async () => {
    const { ptBR: pt } = await import('./i18n/pt-BR')
    expect(pt['money.blockAmount']).not.toMatch(/ponto no decimal/)
  })
})

describe('the receive request reads its amount through the same rule', () => {
  // A second normaliser lived here (`replace(',', '.')` and its own regex) and had already drifted:
  // it accepted more than 8 decimals and put them in the ZIP-321 URI.
  it('Receive parses the requested amount with amountTyped and parseZecToZat', () => {
    const code = codeOf('screens/Receive.tsx')
    expect(code).toMatch(/parseZecToZat\(amountTyped\(amount\)\)/)
    expect(code, 'Receive normalises the comma by itself again').not.toMatch(/replace\(',', '\.'\)/)
  })
})

describe('creation does not read a vault the coordinator does not know yet', () => {
  // Every new member got a 404 on the proposal list during creation: the list loaded as soon as the
  // group key existed, before the vault was registered. It is only used to sign, so it waits for
  // the registration.
  it('the proposal auto-load waits for the registration', () => {
    const code = codeOf('screens/NetVault.tsx')
    expect(code).toMatch(/if \(helperConfigured\(\) && groupVk && hostedState === 'registered'\) void loadProposals\(\)/)
  })
})

describe('the amount refusals say what to type (Daniel, 2026-10-21)', () => {
  it('both languages carry the approved sentences', async () => {
    const { ptBR } = await import('./i18n/pt-BR')
    const { en } = await import('./i18n/en')
    expect(ptBR['money.blockAmount']).toBe('Use um só separador decimal. Por exemplo, digite 1,5.')
    expect(en['money.blockAmount']).toBe('Use a single decimal point. For example, type 1.5.')
    expect(ptBR['money.blockAmountAmbiguous']).toBe('Esse valor é ambíguo. Digite 1,5 ou 1500.')
    expect(en['money.blockAmountAmbiguous']).toBe('That amount is ambiguous. Type 1.5 or 1500.')
  })

  it('the payment screen tells the gate when the amount is ambiguous', () => {
    expect(codeOf('screens/NewPayment.tsx')).toMatch(/amountAmbiguous: amountAmbiguous\(value\)/)
  })
})
