import { describe, expect, it } from 'vitest'
import { withRegistryRows, type Row } from './screens/NewPayroll'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* (#299): the payroll's actions sit above the table, in the order they are used, and
 * "from the registry" adds lines in batch. The key `payroll.fromRegistry` had been written and
 * nothing used it: a treasurer with twelve people in the registry typed twelve lines, one at a
 * time, through the picker of each row. */

const b = (id: string, name: string, address: string, memo = '') => ({ id, name, address, memo, is_public: false })
const empty: Row = { label: '', address: '', value: '', memo: '' }

describe('lines from the registry, in batch', () => {
  const regs = [b('1', 'Ana', 'u1aaa', 'salário'), b('2', 'Bia', 'u1bbb'), b('3', 'Caio', 'u1ccc')]
  it('adds one line per chosen person, with name, address and memo, and an empty value', () => {
    const out = withRegistryRows([empty], regs, ['1', '3'])
    expect(out).toEqual([
      { label: 'Ana', address: 'u1aaa', value: '', memo: 'salário' },
      { label: 'Caio', address: 'u1ccc', value: '', memo: '' },
    ])
  })
  it('keeps the lines already typed and only replaces a trailing empty one', () => {
    const typed: Row = { label: 'Dani', address: 'u1ddd', value: '0.5', memo: '' }
    expect(withRegistryRows([typed, empty], regs, ['2'])).toEqual([typed, { label: 'Bia', address: 'u1bbb', value: '', memo: '' }])
    expect(withRegistryRows([typed], regs, ['2'])).toEqual([typed, { label: 'Bia', address: 'u1bbb', value: '', memo: '' }])
  })
  it('skips a person whose address is already on the sheet', () => {
    const onSheet: Row = { label: 'x', address: 'u1aaa', value: '1', memo: '' }
    expect(withRegistryRows([onSheet], regs, ['1', '2'])).toEqual([onSheet, { label: 'Bia', address: 'u1bbb', value: '', memo: '' }])
  })
  it('ignores an id that is not in the registry, and changes nothing when nothing is chosen', () => {
    expect(withRegistryRows([empty], regs, ['9'])).toEqual([empty])
    expect(withRegistryRows([empty], regs, [])).toEqual([empty])
  })
})

describe('the actions sit above the table, in the order they are used', () => {
  const src = codeOf('screens/NewPayroll.tsx')
  it('the actions block comes before the table head', () => {
    expect(src.indexOf('folha-actions')).toBeGreaterThan(0)
    expect(src.indexOf('folha-actions')).toBeLessThan(src.indexOf('className="plr-head"'))
  })
  it('from the registry, then add a line, then import a CSV', () => {
    const block = src.slice(src.indexOf('folha-actions'), src.indexOf('className="plr-head"'))
    const i = (k: string) => { const n = block.indexOf(k); expect(n, k).toBeGreaterThan(-1); return n }
    expect(i("t('payroll.fromRegistry')")).toBeLessThan(i("t('payroll.addRow')"))
    expect(i("t('payroll.addRow')")).toBeLessThan(i("t('payroll.importCsv')"))
  })
  it('the words exist in both languages', () => {
    for (const k of ['payroll.fromRegistry', 'payroll.registryTitle', 'payroll.registryEmpty', 'payroll.registryOnSheet', 'payroll.registryAdd', 'payroll.registryAddOne']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
    }
    expect(en['payroll.registryAdd']).toContain('{n}')
  })
})
