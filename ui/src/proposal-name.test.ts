import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PAYROLL_TITLE_MAX, proposalName, titleTooLong } from './proposal-name'
import { codeAt } from './source-scan'

describe('the name a proposal is shown under (#296)', () => {
  it("a payroll's own title wins over its memo", () => {
    expect(proposalName({ title: 'Payroll · April 2026', memo: 'old description' }, 'Payroll')).toBe('Payroll · April 2026')
  })

  it('with no title, the memo still names it (a payment, or a payroll from the local bridge)', () => {
    expect(proposalName({ memo: 'rent' }, 'Payment')).toBe('rent')
    expect(proposalName({ title: null, memo: 'Folha - 3 pagamentos' }, 'Payroll')).toBe('Folha - 3 pagamentos')
  })

  it('with neither, the current label, so an old record reads exactly as before', () => {
    expect(proposalName({}, 'Payroll')).toBe('Payroll')
    expect(proposalName({ title: '  ', memo: ' ' }, 'Payroll')).toBe('Payroll')
  })

  it('counts characters the way the coordinator does, not UTF-16 units', () => {
    expect(titleTooLong('ç'.repeat(PAYROLL_TITLE_MAX))).toBe(false)
    expect(titleTooLong('😀'.repeat(PAYROLL_TITLE_MAX))).toBe(false) // 240 UTF-16 units, 120 characters
    expect(titleTooLong('a'.repeat(PAYROLL_TITLE_MAX + 1))).toBe(true)
    expect(titleTooLong(`  ${'a'.repeat(PAYROLL_TITLE_MAX)}  `)).toBe(false)
  })
})

// The rule existed eight times, once per screen, which is how the web payroll ended up nameless on
// all of them at once. A screen that names a proposal from its memo on its own is a second copy.
describe('no screen names a proposal from its memo on its own', () => {
  const dir = join(new URL('.', import.meta.url).pathname, 'screens')
  const own = /\.memo(\?\.trim\(\))?\s*\|\|\s*(\(|t\()/
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx') && !n.includes('.test.'))) {
    it(f, () => {
      const hit = codeAt(join(dir, f)).split('\n').find((l) => own.test(l))
      expect(hit, `${f} names a proposal from its memo; use proposalName`).toBeUndefined()
    })
  }
})

// The screen refuses an over-long name before it asks, with words, rather than letting the
// coordinator's 400 arrive as a generic refusal.
describe('the payroll screen checks the bound before it sends (#296)', () => {
  it('titleTooLong runs on the name before createPayroll', () => {
    const code = codeAt(join(new URL('.', import.meta.url).pathname, 'screens', 'NewPayroll.tsx'))
    const check = code.indexOf('titleTooLong(desc)')
    const send = code.indexOf('await createPayroll(')
    expect(check, 'no titleTooLong(desc) in NewPayroll').toBeGreaterThan(-1)
    expect(check).toBeLessThan(send)
  })
})
