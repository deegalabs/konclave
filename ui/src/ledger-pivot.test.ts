import { describe, expect, it } from 'vitest'
import { pivotByPayee, pivotEntries, pivotCheck, type PivotEntry } from './ledgerPivot'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* #778: the book by beneficiary. Paid so far and still to pay, per person, over the rows in view,
 * the way the community's spreadsheet pivots its distribution; and a check that the pivot's sums
 * are the book's totals, so a payroll whose lines could not be read is visible as a difference,
 * never silently absorbed. Money in whole zatoshi (#303). */

const e = (address: string, zat: number, o: Partial<PivotEntry> = {}): PivotEntry =>
  ({ address, label: '', settled: true, open: false, zat, ...o })

describe('grouping by payee', () => {
  it('groups by address, trimmed, and sums paid and due apart', () => {
    const rows = pivotByPayee([e('u1aaa', 100), e(' u1aaa ', 50, { settled: false, open: true }), e('u1bbb', 30)]).rows
    expect(rows).toEqual([
      { address: 'u1aaa', name: '', paidZat: 100, dueZat: 50, lines: 2 },
      { address: 'u1bbb', name: '', paidZat: 30, dueZat: 0, lines: 1 },
    ])
  })
  it('names the payee by the registry, else the first label seen, else nothing', () => {
    const regs = [{ id: '1', name: 'Bia', address: 'u1bbb', memo: '', is_public: false }]
    const rows = pivotByPayee([e('u1aaa', 1, { label: 'Ana' }), e('u1aaa', 1, { label: 'Ana L.' }), e('u1bbb', 1, { label: 'B.' }), e('u1ccc', 1)], regs).rows
    expect(rows.map((r) => r.name)).toEqual(['Ana', 'Bia', ''])
  })
  it('leaves out a closed line (neither settled nor open) and sorts by the larger sum', () => {
    const rows = pivotByPayee([e('u1aaa', 5), e('u1bbb', 500), e('u1ccc', 9, { settled: false, open: false })]).rows
    expect(rows.map((r) => r.address)).toEqual(['u1bbb', 'u1aaa'])
  })
  it('carries the two totals', () => {
    const t = pivotByPayee([e('u1aaa', 100), e('u1bbb', 50, { settled: false, open: true })]).totals
    expect(t).toEqual({ paidZat: 100, dueZat: 50 })
  })
})

describe('entries from the book', () => {
  const pay = { id: 'p1', kind: 'payment' as const, state: 'confirmed', to_address: 'u1aaa', value_zat: 100, approvals: [], refusals: [], approvals_count: 0, proposer: 'x', is_public: false, vault_id: 'v', value_zec: '0.000001' }
  const roll = { ...pay, id: 'r1', kind: 'payroll' as const, state: 'ready', to_address: undefined, value_zat: 70 }
  const lines = { r1: [{ label: 'Ana', address: 'u1aaa', value_zat: 40, value_zec: '', memo: '', is_public: false }, { label: 'Bia', address: 'u1bbb', value_zat: 30, value_zec: '', memo: '', is_public: false }] }
  it('a payment is one entry, a payroll one per line, with the proposal state', () => {
    const { entries, missing } = pivotEntries([pay, roll], lines, (s) => s === 'confirmed' || s === 'sent', (p) => p.state === 'ready' || p.state === 'awaiting')
    expect(entries).toEqual([
      { address: 'u1aaa', label: '', settled: true, open: false, zat: 100 },
      { address: 'u1aaa', label: 'Ana', settled: false, open: true, zat: 40 },
      { address: 'u1bbb', label: 'Bia', settled: false, open: true, zat: 30 },
    ])
    expect(missing).toEqual([])
  })
  it('a payroll whose lines were not read is counted as missing, not as zero', () => {
    const { entries, missing } = pivotEntries([roll], {}, () => false, () => true)
    expect(entries).toEqual([])
    expect(missing).toEqual(['r1'])
  })
  it('and so is one that answered an empty list: the export counts it at its own value', () => {
    expect(pivotEntries([roll], { r1: [] }, () => false, () => true).missing).toEqual(['r1'])
  })
})

describe('the check against the book', () => {
  it('matches when the pivot sums are the totals', () => {
    expect(pivotCheck({ paidZat: 100, dueZat: 50 }, 100, 50)).toEqual({ ok: true, diffZat: 0 })
  })
  it('names the difference when they are not', () => {
    expect(pivotCheck({ paidZat: 100, dueZat: 20 }, 100, 50)).toEqual({ ok: false, diffZat: 30 })
  })
})

describe('the Ledger shows it', () => {
  it('has the section, in both languages', () => {
    const src = codeOf('screens/Ledger.tsx')
    expect(src).toMatch(/pivotByPayee\(/)
    expect(src).toMatch(/t\('ledger\.byPayee'\)/)
    for (const k of ['ledger.byPayee', 'ledger.byPayeeHint', 'ledger.colPayee', 'ledger.colPaid', 'ledger.colDue', 'ledger.colLines', 'ledger.pivotMatches', 'ledger.pivotMismatch', 'ledger.pivotMismatchNone', 'ledger.pivotLoading', 'ledger.pivotEmpty', 'ledger.pivotTotal', 'ledger.pivotNone']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
    }
    expect(en['ledger.pivotMismatch']).toContain('{diff}')
    // the columns carry the band's own words, so the check is visible to the eye
    expect(en['ledger.colPaid']).toBe(en['ledger.settledOut']?.replace(' out', '') ?? 'Settled')
    expect(ptBR['ledger.colDue']).toBe('Em aberto')
  })
})
