// Kills the survivors in approved-plan.test.ts: pure, no screen.
import { describe, expect, it } from 'vitest'
import { approvedPlanOf, planAfterRead } from './approved-payment'
const payment = { kind: 'payment', to_address: 'u1payee', value_zat: 5000, memo: 'rent', is_public: false }
const payroll = { kind: 'payroll', to_address: '', value_zat: 300, memo: 'October', is_public: false }
const line = (address: string, value_zat: number, memo = '', is_public = false) => ({ label: 'x', address, value_zat, memo, is_public })
const pay2 = [line('u1a', 100, 'a'), line('u1b', 200, 'b')]
describe('approvedPlanOf, what the existing fixtures do not reach', () => {
  it.each([[1.5], [Number.MAX_SAFE_INTEGER + 1], [Number.NaN], [Number.POSITIVE_INFINITY]])('refuses a value of %s', (v) => {
    expect(approvedPlanOf({ proposal: { ...payment, value_zat: v }, lines: [] })).toBeNull()
  })
  it('refuses a fractional payroll line that sums', () => {
    expect(approvedPlanOf({ proposal: payroll, lines: [line('u1a', 100.5), line('u1b', 199.5)] })).toBeNull()
  })
  it('an unknown kind is refused with the shape of a payroll, too', () => {
    expect(approvedPlanOf({ proposal: { ...payroll, kind: 'sweep' }, lines: [line('u1a', 300)] })).toBeNull()
  })
  it('carries the public flag, the label, the memo, and a trimmed address', () => {
    const a = approvedPlanOf({ proposal: { ...payment, to_address: ' u1payee ', is_public: true }, lines: [] })!
    expect(a.lines[0]).toMatchObject({ address: 'u1payee', isPublic: true })
    expect(a.memo).toBe('rent')
    const b = approvedPlanOf({ proposal: payroll, lines: [line(' u1a ', 300, '', true)] })!
    expect(b.lines[0]).toMatchObject({ address: 'u1a', isPublic: true, label: 'x' })
    expect(b.memo).toBe('October')
  })
})
describe('planAfterRead, comparison by comparison', () => {
  const first = approvedPlanOf({ proposal: payroll, lines: pay2 })!
  it('an answer that does not hold together is a refusal, not a throw', () => {
    expect(planAfterRead(payment, undefined, { proposal: { ...payment, to_address: '' }, lines: [] })).toBeNull()
    expect(planAfterRead(payroll, first, { proposal: payroll, lines: [] })).toBeNull()
  })
  it('amounts moved between lines, total kept', () => {
    expect(planAfterRead(payroll, first, { proposal: payroll, lines: [line('u1a', 200, 'a'), line('u1b', 100, 'b')] })).toBeNull()
  })
  it('a line memo changed', () => {
    expect(planAfterRead(payroll, first, { proposal: payroll, lines: [line('u1a', 100, 'a'), line('u1b', 200, 'other')] })).toBeNull()
  })
  it('the total changed, and the member reopened from the new total', () => {
    const bigger = { ...payroll, value_zat: 400 }
    expect(planAfterRead(bigger, first, { proposal: bigger, lines: [line('u1a', 100, 'a'), line('u1b', 300, 'b')] })).toBeNull()
    expect(planAfterRead(bigger, first, { proposal: bigger, lines: [line('u1a', 100, 'a'), line('u1b', 200, 'b'), line('u1c', 100)] })).toBeNull()
  })
  it('the kind changed, same address and amount', () => {
    const onePay = approvedPlanOf({ proposal: { ...payment, memo: '' }, lines: [] })!
    const asPayroll = { kind: 'payroll', to_address: '', value_zat: 5000 }
    expect(planAfterRead(asPayroll, onePay, { proposal: asPayroll, lines: [line('u1payee', 5000)] })).toBeNull()
  })
})
