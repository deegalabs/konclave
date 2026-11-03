import { describe, expect, it } from 'vitest'
import { rowIssue } from './screens/NewPayroll'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* (#294): a payroll line with an older shielded (Sapling) address is refused on the line.
 *
 * The vault pays Orchard receivers only (the coordinator's `payment_plan` refuses anything else),
 * and the payee picker already said so under the field, but the row was not a problem: it counted
 * as valid, the payroll composed, and the refusal came back from the coordinator for the whole
 * sheet. The word for the line, `payroll.cellSapling`, had been written and never used. */

const row = (address: string) => ({ label: 'Ana', address, value: '0.001', memo: '' })

describe('a Sapling line is a problem of the line', () => {
  it('names it with the text written for it', () => {
    expect(rowIssue(row('zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'))).toBe('payroll.cellSapling')
  })
  it('does not touch a current shielded line', () => {
    expect(rowIssue(row('u1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'))).toBeNull()
  })
  it('comes after the empty and unknown checks, before the amount', () => {
    expect(rowIssue({ ...row('zs1qqq'), value: 'abc' })).toBe('payroll.cellSapling')
    expect(rowIssue(row(''))).toBe('payroll.issueEmpty')
  })
  it('the word exists in both languages and says what to use instead', () => {
    expect(en['payroll.cellSapling']).toMatch(/u1/)
    expect(ptBR['payroll.cellSapling']).toMatch(/u1/)
  })
})
