import { describe, expect, it } from 'vitest'
import { approvedLinesFor, approvedPlanOf, forgetPlansForTests, planAfterRead, readPlan } from './approved-payment'
import { codeOf } from './source-scan'

const decode = (a: string) => `rcv:${a}`
const payment = { kind: 'payment', to_address: 'u1payee', value_zat: 5000, memo: 'rent', is_public: false }
const payroll = { kind: 'payroll', to_address: '', value_zat: 300, memo: 'October', is_public: false }
const line = (address: string, value_zat: number, memo = '') => ({ label: 'x', address, value_zat, memo, is_public: false })

describe('the one reading of a proposal', () => {
  it('a payment, as the coordinator writes it: an address and no lines', () => {
    const plan = approvedPlanOf({ proposal: payment, lines: [] })!
    expect(plan.kind).toBe('payment')
    expect(plan.totalZat).toBe(5000)
    expect(plan.lines.map((l) => [l.address, l.amountZat, l.memo])).toEqual([['u1payee', 5000, 'rent']])
  })

  it('a payroll, as the coordinator writes it: no address and lines that sum to the value', () => {
    const plan = approvedPlanOf({ proposal: payroll, lines: [line('u1a', 100, 'a'), line('u1b', 200)] })!
    expect(plan.kind).toBe('payroll')
    expect(plan.totalZat).toBe(300)
    expect(plan.lines.map((l) => l.address)).toEqual(['u1a', 'u1b'])
  })

  it('a payroll from the local bridge has a null-ish address', () => {
    expect(approvedPlanOf({ proposal: { ...payroll, to_address: undefined }, lines: [line('u1a', 300)] })).not.toBeNull()
  })

  it.each([
    ['a payment with lines', { proposal: payment, lines: [line('u1other', 5000)] }],
    ['a payment with no address', { proposal: { ...payment, to_address: '' }, lines: [] }],
    ['a payment of nothing', { proposal: { ...payment, value_zat: 0 }, lines: [] }],
    ['a payroll with no lines', { proposal: payroll, lines: [] }],
    ['a payroll whose lines do not sum to the value', { proposal: payroll, lines: [line('u1a', 100)] }],
    ['a payroll that also names an address', { proposal: { ...payroll, to_address: 'u1payee' }, lines: [line('u1a', 300)] }],
    ['a payroll line with no address', { proposal: payroll, lines: [line('', 300)] }],
    ['a payroll line of nothing', { proposal: payroll, lines: [line('u1a', 300), line('u1b', 0)] }],
    ['a negative line that makes the sum work', { proposal: payroll, lines: [line('u1a', 500), line('u1b', -200)] }],
    ['an unknown kind', { proposal: { ...payment, kind: 'sweep' }, lines: [] }],
  ])('refuses %s', (_name, detail) => {
    expect(approvedPlanOf(detail)).toBeNull()
  })

  it('the gate compares what the plan says', () => {
    expect(approvedLinesFor(approvedPlanOf({ proposal: payment, lines: [] })!, decode)).toEqual([{ toReceiver: 'rcv:u1payee', amountZat: 5000, memo: 'rent' }])
    expect(approvedLinesFor(approvedPlanOf({ proposal: payroll, lines: [line('u1a', 300, 'p')] })!, decode)).toEqual([{ toReceiver: 'rcv:u1a', amountZat: 300, memo: 'p' }])
  })
})

describe('nothing else reads the destination', () => {
  it('the confirm and the panel list a payroll in full', () => {
    const panel = codeOf('./screens/SigningPanel.tsx')
    expect(panel).toMatch(/<PlanLines lines=\{plan\.lines\} \/>/)
    expect(panel).toMatch(/<PlanLines lines=\{payrollLines\} \/>/)
    expect(panel).toMatch(/payrollLines=\{plan\?\.lines\}/)
  })

  it('the signer goes through the plan', () => {
    const src = codeOf('./VaultSigner.tsx')
    expect(src).toContain('approvedLinesFor(')
    expect(src).not.toMatch(/toReceiver|\.to_address/)
  })

  const NOT_THE_PLAN = /\.to_address|\.value_zec|\.value_zat|\b(p|active)\.kind\b|(?<![.?])\blines\.(map|length)/

  it('the panel shows the plan the gate compares, from the same read', () => {
    const signer = codeOf('./VaultSigner.tsx')
    expect(signer).toMatch(/let plan = readPlan\(active\.id, active, detail\)/)
    expect(signer).toMatch(/approvedLinesFor\(plan, uaReceiver\)/)
    const panel = codeOf('./screens/SigningPanel.tsx')
    expect(panel).not.toMatch(/getProposalDetail|approvedPlanOf/)
    expect(panel).not.toMatch(NOT_THE_PLAN)
  })

  it('the proposal page shows the plan', () => {
    const page = codeOf('./screens/Proposal.tsx')
    expect(page).toContain('readPlan(')
    expect(page).not.toMatch(NOT_THE_PLAN)
  })
})

describe('a later reading', () => {
  const honest = { proposal: payment, lines: [] }
  const changed = { proposal: { ...payment, to_address: 'u1other' }, lines: [] }
  const plan = approvedPlanOf(honest)!

  it('an answer that agrees with what the member opened is the plan', () => {
    expect(planAfterRead(payment, undefined, honest)).toEqual(plan)
    expect(planAfterRead(payment, plan, honest)).toEqual(plan)
  })

  it.each([
    ['another address', { ...payment, to_address: 'u1other' }],
    ['another amount', { ...payment, value_zat: 6000 }],
    ['another memo', { ...payment, memo: 'other' }],
    ['another kind', { ...payment, kind: 'payroll' }],
  ])('a reading differs from what the member opened: %s', (_n, opened) => {
    expect(planAfterRead(opened, undefined, honest)).toBeNull()
  })

  it('a later reading that differs refuses, and one that agrees after it does not undo that', () => {
    const later = planAfterRead({ ...payment, to_address: 'u1other' }, plan, changed)
    expect(later).toBeNull()
    expect(planAfterRead(payment, later, honest)).toBeNull()
  })

  it('a payroll whose total agrees but whose lines changed is refused on the later read', () => {
    const first = approvedPlanOf({ proposal: payroll, lines: [line('u1a', 100), line('u1b', 200)] })!
    expect(planAfterRead(payroll, first, { proposal: payroll, lines: [line('u1a', 100), line('u1another', 200)] })).toBeNull()
  })
})

describe('one memory across the screens and the signer', () => {
  it('a second reading of a payroll with other lines and the same total: refused', () => {
    forgetPlansForTests()
    const page = { proposal: payroll, lines: [line('u1a', 100), line('u1b', 200)] }
    expect(readPlan('px', payroll, page)).not.toBeNull()
    expect(readPlan('px', payroll, { proposal: payroll, lines: [line('u1a', 100), line('u1another', 200)] })).toBeNull()
    expect(readPlan('px', payroll, page), 'and it stays').toBeNull()
  })

  it('another proposal in between does not reset it', () => {
    forgetPlansForTests()
    const changed = { proposal: { ...payment, to_address: 'u1another' }, lines: [] }
    expect(readPlan('p1', payment, { proposal: payment, lines: [] })).not.toBeNull()
    expect(readPlan('p2', payroll, { proposal: payroll, lines: [line('u1a', 300)] })).not.toBeNull()
    expect(readPlan('p1', changed.proposal, changed)).toBeNull()
  })
})
