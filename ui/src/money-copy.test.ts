import { describe, expect, it } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* (#127): the money screens speak the member's words.
 *
 * Three rules, checked on the keys the Pay, Payroll and Receive
 * screens render: "coordenador" stays in the docs and the trust panel, on screen it is "the
 * vault's server"; pools are an engine word, the screen says "shielded" or describes the split
 * without naming it; and "u1…" is explained once per screen, where the address is shown or typed,
 * not on every line that mentions the address. */

const both = (k: string) => [en[k]!, ptBR[k]!]

describe('the money screens never say "coordinator"', () => {
  for (const k of ['payment.memoLabel', 'receive.addressDiffers']) {
    it(k, () => {
      for (const s of both(k)) expect(s).not.toMatch(/coordinator|coordenador/i)
    })
  }
  it('the memo label names the vault’s server instead, ', () => {
    expect(en['payment.memoLabel']).toMatch(/vault’s server/)
    expect(ptBR['payment.memoLabel']).toMatch(/servidor do cofre/)
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
    for (const k of ['rec.placeholder', 'payroll.recipientPlaceholder', 'rec.addAddr', 'payment.toSapling', 'payment.toTransparent', 'payroll.cellSapling', 'payroll.cellTransparent', 'receive.address']) {
      expect(en[k], k).toMatch(/starts with u1/)
      expect(ptBR[k], k).toMatch(/começa com u1/)
      for (const s of both(k)) expect(s, k).not.toMatch(/u1…/)
    }
  })
})
