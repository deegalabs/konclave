import { describe, expect, it } from 'vitest'
import type { PayrollLine, Proposal } from './api'
import { codeOf } from './source-scan'
import { unusualFor } from './unusual'

/* "Out of the ordinary": a product rule that points at what a voter may want to look at twice. It
 * reads the vault's own book and nothing else, and it promises nothing: a payment it does not flag
 * is not thereby safe. Three things, one rule: the first payment to an address, an amount well above
 * what that address usually receives, and a payroll that changed from the previous one. */

let n = 0
const at = (d: number) => 1_700_000_000 + d * 86_400
const pay = (to: string, zat: number, day: number, state = 'confirmed', o: Partial<Proposal> = {}): Proposal => ({
  id: `p${n++}`, vault_id: 'v', kind: 'payment', state, proposer: 'ana', value_zat: zat, value_zec: '',
  to_address: to, is_public: false, created_at: at(day), approvals: [], refusals: [], approvals_count: 0, ...o,
})
const roll = (zat: number, day: number, state = 'confirmed', id = `r${n++}`): Proposal =>
  pay('', zat, day, state, { id, kind: 'payroll', to_address: undefined })
const line = (address: string, zat: number): PayrollLine => ({ label: '', address, value_zat: zat, value_zec: '', memo: '', is_public: false })

describe('first payment to an address', () => {
  it('flags an address the vault has never paid', () => {
    const r = unusualFor(pay('u1new', 10, 9, 'awaiting'), null, [pay('u1old', 10, 1)], {})
    expect(r.findings).toEqual([{ kind: 'first-payment', address: 'u1new' }])
  })
  it('does not flag an address paid before, even with spaces around it', () => {
    const r = unusualFor(pay('u1old', 10, 9, 'awaiting'), null, [pay(' u1old ', 10, 1)], {})
    expect(r.findings).toEqual([])
  })
  it('counts only money that left: a refused or open earlier proposal is not a payment', () => {
    const r = unusualFor(pay('u1x', 10, 9, 'awaiting'), null, [pay('u1x', 10, 1, 'rejected'), pay('u1x', 10, 2, 'awaiting')], {})
    expect(r.findings).toEqual([{ kind: 'first-payment', address: 'u1x' }])
  })
  it('counts a line of an earlier payroll as a payment to that address', () => {
    const prev = roll(30, 1, 'confirmed', 'r-prev')
    const r = unusualFor(pay('u1bia', 10, 9, 'awaiting'), null, [prev], { 'r-prev': [line('u1bia', 30)] })
    expect(r.findings).toEqual([])
  })
  it('compares only with what came before the proposal, never with later payments', () => {
    const r = unusualFor(pay('u1x', 10, 5, 'confirmed'), null, [pay('u1x', 10, 8)], {})
    expect(r.findings).toEqual([{ kind: 'first-payment', address: 'u1x' }])
  })
  it('takes a null creation date (the local bridge sends it for older proposals) for no date', () => {
    const undatedNow = pay('u1x', 10, 9, 'awaiting', { created_at: null as unknown as undefined })
    expect(unusualFor(undatedNow, null, [pay('u1x', 10, 1)], {}).findings).toEqual([])
    const undatedBefore = pay('u1y', 10, 1, 'confirmed', { created_at: null as unknown as undefined })
    expect(unusualFor(pay('u1y', 10, 9, 'awaiting'), null, [undatedBefore], {}).findings).toEqual([])
  })
  it('counts an earlier payment created in the same second as the proposal as earlier', () => {
    const r = unusualFor(pay('u1x', 10, 9, 'awaiting'), null, [pay('u1x', 10, 9)], {})
    expect(r.findings).toEqual([])
  })
  it('says the reading is incomplete when the payment has no address to compare', () => {
    for (const to of [undefined, '', '   ']) {
      const r = unusualFor(pay('', 10, 9, 'awaiting', { to_address: to }), null, [pay('u1x', 10, 1)], {})
      expect(r).toEqual({ findings: [], incomplete: true, comparedTo: null })
    }
  })
  it('says the reading is incomplete when an earlier payroll could not be read', () => {
    const r = unusualFor(pay('u1x', 10, 9, 'awaiting'), null, [roll(30, 1)], {})
    expect(r.incomplete).toBe(true)
    expect(r.findings).toEqual([{ kind: 'first-payment', address: 'u1x' }])
  })
})

describe('an amount above what the address usually receives', () => {
  const earlier = [pay('u1x', 100, 1), pay('u1x', 120, 2), pay('u1x', 90, 3)] // median 100
  it('flags more than twice the median of the earlier payments to that address', () => {
    const r = unusualFor(pay('u1x', 201, 9, 'awaiting'), null, earlier, {})
    expect(r.findings).toEqual([{ kind: 'above-usual', address: 'u1x', valueZat: 201, medianZat: 100 }])
  })
  it('does not flag exactly twice the median', () => {
    expect(unusualFor(pay('u1x', 200, 9, 'awaiting'), null, earlier, {}).findings).toEqual([])
  })
  it('takes the median of an even count as the middle two: the rule is exact, the median shown is whole zatoshi', () => {
    const four = [...earlier, pay('u1x', 101, 4)] // middle two 100 and 101: twice the median is 201
    expect(unusualFor(pay('u1x', 201, 9, 'awaiting'), null, four, {}).findings).toEqual([])
    expect(unusualFor(pay('u1x', 202, 9, 'awaiting'), null, four, {}).findings).toEqual([{ kind: 'above-usual', address: 'u1x', valueZat: 202, medianZat: 100 }])
  })
  it('a payroll that repeats one paying an address in three lines is not above usual', () => {
    const three = [line('u1ana', 10), line('u1ana', 10), line('u1ana', 10)]
    const history = [roll(30, 1, 'confirmed', 'a'), roll(30, 2, 'confirmed', 'b'), roll(30, 3, 'confirmed', 'c')]
    const r = unusualFor(roll(30, 9, 'awaiting'), three, history, { a: three, b: three, c: three })
    expect(r.findings).toEqual([])
  })
  it('needs at least three earlier payments before it speaks of a usual amount', () => {
    expect(unusualFor(pay('u1x', 999, 9, 'awaiting'), null, earlier.slice(0, 2), {}).findings).toEqual([])
  })
})

describe('a payroll that changed from the previous one', () => {
  const hist = () => {
    const old = roll(60, 1, 'confirmed', 'r-old')
    const prev = roll(60, 5, 'sent', 'r-prev')
    return { history: [old, prev], lines: { 'r-old': [line('u1zz', 60)], 'r-prev': [line('u1ana', 30), line('u1bia', 30)] } }
  }
  it('names who was added, who was removed and whose amount changed, against the latest earlier payroll', () => {
    const { history, lines } = hist()
    const target = roll(0, 9, 'awaiting', 'r-now')
    const r = unusualFor(target, [line('u1ana', 45), line('u1zz', 10)], history, lines)
    expect(r.comparedTo).toBe('r-prev')
    expect(r.findings).toEqual([
      { kind: 'payroll-added', address: 'u1zz' },
      { kind: 'payroll-removed', address: 'u1bia' },
      { kind: 'payroll-amount', address: 'u1ana', beforeZat: 30, afterZat: 45 },
    ])
  })
  it('never takes a refused or open payroll as the previous one', () => {
    const { history, lines } = hist()
    const refused = roll(60, 7, 'rejected', 'r-ref')
    const r = unusualFor(roll(60, 9, 'awaiting'), [line('u1ana', 30), line('u1bia', 30)], [...history, refused], { ...lines, 'r-ref': [line('u1qq', 60)] })
    expect(r.comparedTo).toBe('r-prev')
    expect(r.findings).toEqual([])
  })
  it('says nothing when the payroll repeats the previous one', () => {
    const { history, lines } = hist()
    const r = unusualFor(roll(60, 9, 'awaiting'), [line('u1bia', 30), line('u1ana', 30)], history, lines)
    expect(r.findings).toEqual([])
    expect(r.incomplete).toBe(false)
  })
  it('adds up two lines to one address before comparing', () => {
    const { history, lines } = hist()
    const r = unusualFor(roll(60, 9, 'awaiting'), [line('u1ana', 10), line('u1ana', 20), line('u1bia', 30)], history, lines)
    expect(r.findings).toEqual([])
  })
  it('does not compare with a previous payroll it could not read, and says so', () => {
    const r = unusualFor(roll(60, 9, 'awaiting'), [line('u1ana', 30)], [roll(60, 5, 'sent', 'r-x')], {})
    expect(r.comparedTo).toBe(null)
    expect(r.incomplete).toBe(true)
    expect(r.findings).toEqual([{ kind: 'first-payment', address: 'u1ana' }])
  })
  it('says the reading is incomplete when the payroll under review has no lines to read', () => {
    const { history, lines } = hist()
    const r = unusualFor(roll(60, 9, 'awaiting'), null, history, lines)
    expect(r).toEqual({ findings: [], incomplete: true, comparedTo: null })
  })
  it('says the reading is incomplete when a payroll line has no address, and still reads the others', () => {
    const r = unusualFor(roll(60, 9, 'awaiting'), [line('u1n', 30), line('  ', 30)], [], {})
    expect(r.incomplete).toBe(true)
    expect(r.findings).toEqual([{ kind: 'first-payment', address: 'u1n' }])
  })
  it('flags each address of the payroll only once as a first payment', () => {
    const r = unusualFor(roll(60, 9, 'awaiting'), [line('u1n', 30), line('u1n', 30)], [], {})
    expect(r.findings).toEqual([{ kind: 'first-payment', address: 'u1n' }])
  })
})

describe('one book, one rule', () => {
  it('reads SETTLED and the ledger pivot instead of a list or an itemizer of its own', () => {
    const code = codeOf('unusual.ts')
    expect(code).toMatch(/import \{ SETTLED \} from '\.\/ledger-state'/)
    expect(code).toMatch(/import \{ pivotEntries \} from '\.\/ledgerPivot'/)
    expect(code).not.toMatch(/'sent'|'confirmed'|itemizeBook/)
  })
  it('reads a creation date through the one reader that takes null for no date', () => {
    const code = codeOf('unusual.ts')
    expect(code).toMatch(/import \{ createdAt \} from '\.\/period'/)
    expect(code).not.toMatch(/\.created_at/)
  })
})
