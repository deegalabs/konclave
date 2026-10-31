import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { codeOf } from './source-scan'

/* (#127): the money screens speak the member's words.
 *
 * Three rules, checked on the keys the Pay, Payroll and Receive
 * screens render: "coordenador" stays in the docs and the trust panel, on screen it is "the
 * vault's server"; pools are an engine word, the screen says "shielded" or describes the split
 * without naming it; and "u1…" is explained once per screen, where the address is shown or typed,
 * not on every line that mentions the address. */

const both = (k: string) => [en[k]!, ptBR[k]!]

describe('the money screens never say "coordinator"', () => {
  for (const k of ['payment.memoLabel', 'payment.memoHelp', 'receive.addressDiffers']) {
    it(k, () => {
      for (const s of both(k)) expect(s).not.toMatch(/coordinator|coordenador/i)
    })
  }
  it('who reads the memo names the vault’s server instead, under the field (#799)', () => {
    expect(en['payment.memoHelp']).toMatch(/vault’s server/)
    expect(ptBR['payment.memoHelp']).toMatch(/servidor do cofre/)
  })
})

describe('the split of the balance is described, not named after the engine', () => {
  // The gate on the screen and the server's refusal say the same sentence: two copies of one rule
  // drifted once already. And the sentence names no action the product has no button for.
  for (const k of ['money.blockCrossesPools', 'error.crossesPools']) {
    it(k, () => {
      for (const s of both(k)) {
        expect(s).not.toMatch(/pool|grupos internos/i)
        expect(s).not.toMatch(/consolid/i)
      }
    })
  }
  it('the two keys are one sentence', () => {
    expect(en['money.blockCrossesPools']).toBe(en['error.crossesPools'])
    expect(ptBR['money.blockCrossesPools']).toBe(ptBR['error.crossesPools'])
  })
})

describe('"u1" is explained once per screen', () => {
  it('Receive says it on the address label, not in the lead and the note', () => {
    for (const s of both('receive.address')) expect(s).toMatch(/u1/)
    for (const k of ['receive.lead', 'receive.note']) for (const s of both(k)) expect(s).not.toMatch(/u1/)
  })
  it('the payee field says it where the address is typed, on Pay and on Payroll, not again on the confirmation', () => {
    for (const k of ['rec.placeholder', 'payroll.recipientPlaceholder']) for (const s of both(k)) expect(s).toMatch(/u1/)
    for (const s of both('rec.shieldedOk')) expect(s).not.toMatch(/u1/)
  })
  it('and in one form, "starts with u1", never "u1…"', () => {
    for (const k of ['rec.placeholder', 'payroll.recipientPlaceholder', 'rec.addAddr', 'rec.saplingWarn', 'payroll.cellSapling', 'receive.address', 'people.warnSapling', 'people.addrPlaceholder']) {
      expect(en[k], k).toMatch(/starts with u1/)
      expect(ptBR[k], k).toMatch(/começa com u1/)
      for (const s of both(k)) expect(s, k).not.toMatch(/u1…/)
    }
  })
})

/* #799: four strings the pass above left. An engine word or a standard's number on an everyday
 * screen, a label long enough to wrap on a phone, and the address explained the old way on People. */
describe('what the money-copy pass left', () => {
  it('the payment link does not name its standard', () => {
    for (const s of both('receive.uri')) expect(s).not.toMatch(/ZIP/i)
  })
  it('the history does not say "on-chain"', () => {
    for (const k of ['receive.historyTitle', 'receive.historyNote']) for (const s of both(k)) expect(s, k).not.toMatch(/on-?chain/i)
  })
  it('the memo label is a label: who reads the memo is said under the field', () => {
    for (const s of both('payment.memoLabel')) expect(s.length).toBeLessThanOrEqual(30)
    const src = codeOf('screens/NewPayment.tsx')
    expect(src).toMatch(/aria-describedby="pay-memo-help"/)
    expect(src).toMatch(/<small className="field-help" id="pay-memo-help">\{t\('payment\.memoHelp'\)\}<\/small>/)
  })
  it("People's address field uses its own sentence, and the payroll key it borrowed is gone", () => {
    expect(codeOf('screens/People.tsx')).toMatch(/placeholder=\{t\('people\.addrPlaceholder'\)\}/)
    expect(en['payroll.addrPlaceholder']).toBeUndefined()
    expect(ptBR['payroll.addrPlaceholder']).toBeUndefined()
  })
})
