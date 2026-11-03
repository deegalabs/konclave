import { describe, expect, it } from 'vitest'
import { rowsFromPrevious, patchRow, duplicateOf, rowNote, type Row } from './screens/NewPayroll'
import type { Beneficiary } from './api'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* (#332): a payroll starts from the last one, so nobody retypes addresses every month.
 *
 * Retyping a shielded address by hand, monthly, is the riskiest moment in the product: a wrong
 * address is unrecoverable and nobody proofreads 78 characters twice. The previous payroll's lines
 * are already on the device (getProposalDetail). What is copied: label, address, value, memo.
 * What is never copied: the period (a document that lies about itself), the state, the funding
 * check. A copied line is a line to check, and says so until it is edited; a repeated address is
 * flagged, not silently paid twice (#295). */

const line = (address: string, value_zec: string, label: string | null = 'Ana', memo = 'salário') =>
  ({ label, address, value_zat: Math.round(Number(value_zec) * 1e8), value_zec, memo, is_public: false })

describe('lines from a previous payroll', () => {
  it('copies label, address, value and memo, and marks each line to be checked', () => {
    expect(rowsFromPrevious([line('u1aaa', '0.5'), line('u1bbb', '0.25', null, '')])).toEqual([
      { label: 'Ana', address: 'u1aaa', value: '0.5', memo: 'salário', copied: true, check: true },
      { label: '', address: 'u1bbb', value: '0.25', memo: '', copied: true, check: true },
    ])
  })
  it('copies nothing else: no period, no state', () => {
    const src = codeOf('screens/NewPayroll.tsx')
    const fn = src.slice(src.indexOf('export function rowsFromPrevious'), src.indexOf('\n}', src.indexOf('export function rowsFromPrevious')))
    expect(fn).not.toMatch(/competenc|state|txid|approv/)
    // and starting from a previous one neither reads nor writes the period: what the member typed
    // there stays, and nothing of the old document reaches it
    const start = src.slice(src.indexOf('async function startFromPrevious'), src.indexOf('\n  }', src.indexOf('async function startFromPrevious')))
    expect(start).not.toMatch(/competencia|setCompetencia|setDescription/)
  })
})

describe('a copied line is a line to check, until it is edited', () => {
  const rows: Row[] = [{ label: 'Ana', address: 'u1aaa', value: '0.5', memo: '', copied: true, check: true }, { label: 'Bia', address: 'u1bbb', value: '1', memo: '' }]
  it('editing the address clears the mark on that line only, and the line stays a copied one', () => {
    const out = patchRow(rows, 0, { address: 'u1aab' })
    expect(out[0]).toEqual({ label: 'Ana', address: 'u1aab', value: '0.5', memo: '', copied: true })
    expect(out[1]).toEqual(rows[1])
  })
  it('looking at the address and leaving it (an empty patch) clears it too', () => {
    expect(patchRow(rows, 0, {})[0]).toEqual({ label: 'Ana', address: 'u1aaa', value: '0.5', memo: '', copied: true })
  })
  it('typing an amount or a memo does not: the address was not checked', () => {
    expect(patchRow(rows, 0, { value: '0.6' })[0]).toEqual({ label: 'Ana', address: 'u1aaa', value: '0.6', memo: '', copied: true, check: true })
    expect(patchRow(rows, 0, { memo: 'x' })[0]!.check).toBe(true)
  })
  it('the sheet says the lines were copied and what was not', () => {
    const src = codeOf('screens/NewPayroll.tsx')
    expect(src).toMatch(/t\('payroll\.copiedFrom'/)
    expect(src).toMatch(/key: 'payroll\.rowCopied'/)
    expect(src).toMatch(/t\('payroll\.startFromThis'\)/)
  })
})

describe('a repeated address is flagged, not paid twice in silence (#295)', () => {
  const rows: Row[] = [
    { label: 'Ana', address: 'u1aaa', value: '1', memo: '' },
    { label: 'Bia', address: 'u1bbb', value: '1', memo: '' },
    { label: 'Ana again', address: ' u1aaa ', value: '2', memo: '' },
  ]
  it('names the first line that holds the same address', () => {
    expect(duplicateOf(rows, 2)).toBe(0)
    expect(duplicateOf(rows, 0)).toBeNull()
    expect(duplicateOf(rows, 1)).toBeNull()
  })
  it('ignores empty addresses', () => {
    expect(duplicateOf([{ label: '', address: '', value: '', memo: '' }, { label: '', address: '', value: '', memo: '' }], 1)).toBeNull()
  })
})

describe('the words exist in both languages', () => {
  it('all of them', () => {
    for (const k of ['payroll.startFromThis', 'payroll.copiedFrom', 'payroll.rowCopied', 'payroll.rowStale', 'payroll.rowDuplicate', 'payroll.replaceLinesQ', 'payroll.replaceLines', 'payroll.errPrevious', 'payroll.errPreviousEmpty', 'payroll.copiedUnchecked', 'payroll.copiedUncheckedOne']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
    }
    expect(en['payroll.copiedFrom']).toContain('{doc}')
    expect(en['payroll.rowDuplicate']).toContain('{n}')
  })
})

/* Daniel's review of #776: the registry warning lived on the "not looked at yet" mark, so leaving
 * the address field (which retires that mark) also retired the one warning that can stop a payment
 * to an old address. The two marks are apart now, and what a line says is one pure function. */
describe('what a line says under itself', () => {
  const ana = 'u1' + 'a'.repeat(60), anaNew = 'u1' + 'n'.repeat(60), bia = 'u1' + 'b'.repeat(60)
  const benefs: Beneficiary[] = [{ id: '1', name: 'Ana', address: anaNew, memo: '', is_public: false }]
  const copied = (address: string, label = 'Ana'): Row => ({ label, address, value: '1', memo: '', copied: true, check: true })
  const keyOf = (rows: Row[], i: number) => rowNote(rows, i, benefs)?.key ?? null

  it('a copied line whose name the registry holds with another address says so', () => {
    expect(rowNote([copied(ana)], 0, benefs)).toEqual({ key: 'payroll.rowStale', vars: { name: 'Ana' } })
  })
  it('and keeps saying it after the address was looked at and left', () => {
    const looked = patchRow([copied(ana)], 0, {})
    expect(looked[0]!.check).toBeUndefined()
    expect(keyOf(looked, 0)).toBe('payroll.rowStale')
  })
  it('until the address is the one the registry holds', () => {
    expect(keyOf(patchRow([copied(ana)], 0, { address: anaNew }), 0)).toBeNull()
  })
  it('comes before the duplicate note', () => {
    expect(keyOf([copied(ana, 'Bia'), copied(ana)], 1)).toBe('payroll.rowStale')
  })
  it('a copied line the registry agrees with says only that it was copied, until looked at', () => {
    const rows = [copied(bia, 'Bia')]
    expect(keyOf(rows, 0)).toBe('payroll.rowCopied')
    expect(keyOf(patchRow(rows, 0, {}), 0)).toBeNull()
  })
  it('a line typed by hand is never compared with the registry', () => {
    expect(keyOf([{ label: 'Ana', address: ana, value: '1', memo: '' }], 0)).toBeNull()
  })
  it('a problem that blocks the sheet comes first', () => {
    expect(keyOf([{ ...copied(ana), value: '' }], 0)).toBe('payroll.issueInvalid')
  })
})
