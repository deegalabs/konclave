import { describe, expect, it } from 'vitest'
import { buildLedgerWorkbook, type LedgerXlsxData, type LedgerXlsxItem } from './ledgerXlsx'

/* The export with the spreadsheet's skeleton (#302): a Summary that reads like the accountant's
 * own (position, committed, available, outflows by kind, entries by state) and a third sheet, By
 * beneficiary, built from live SUMIFS over Movements, so the "sums match" check is one the
 * accountant can re-run in the spreadsheet, not a pasted number. */

const labels: LedgerXlsxData['labels'] = {
  summary: 'Summary', movements: 'Movements', byPayee: 'By beneficiary', vault: 'Vault', period: 'Period', filter: 'Filter',
  generated: 'Generated', entries: 'Entries', settledOut: 'Settled out', open: 'Open',
  colDate: 'Date', colDocument: 'Document', colKind: 'Kind', colBeneficiary: 'Beneficiary',
  colAddress: 'Address', colMemo: 'Memo', colProposedBy: 'Proposed by', colApprovedBy: 'Approved by', colState: 'State', colSettled: 'Settled', colOpen: 'Open',
  colValue: 'Value (ZEC)', colTxid: 'Transaction (txid)', total: 'TOTAL', yes: 'yes', no: 'no',
  outPayments: 'Outflows: payments', outPayrolls: 'Outflows: payrolls', byState: 'Entries by state',
  kindPayment: 'Payment', kindPayroll: 'Payroll',
  position: 'Position (total)', committed: 'Committed to open proposals', available: 'Available', confirming: 'Confirming', asOf: 'Balance as of',
  difference: 'Difference vs Summary',
  overCommitted: 'Over-committed', noAddress: 'No address',
}
const item = (over: Partial<LedgerXlsxItem> = {}): LedgerXlsxItem => ({
  dateISO: '2026-10-01', document: 'Rent', kind: 'Payment', beneficiary: '', address: 'u1rent',
  memo: '', proposer: 'Alice', approvers: 'Alice, Bob', state: 'confirmed', settled: true, open: false, zec: 1.5, txid: '', ...over,
})
const items = [
  item(),                                                                                   // rent, settled 1.5
  item({ document: 'October', kind: 'Payroll', beneficiary: 'Ana', address: 'u1ana', zec: 0.5 }), // settled
  item({ document: 'October', kind: 'Payroll', beneficiary: 'Bia', address: 'u1bia', zec: 0.25 }),
  item({ document: 'November', kind: 'Payroll', beneficiary: 'Ana', address: 'u1ana', zec: 0.5, state: 'awaiting', settled: false, open: true }),
  item({ document: 'Refused', address: 'u1rent', zec: 9, state: 'refused', settled: false, open: false }),
]
const generatedAt = new Date('2026-10-31T12:00:00Z')
const data = (its: LedgerXlsxItem[], extra: Partial<LedgerXlsxData> = {}): LedgerXlsxData =>
  ({ vaultName: 'Caixa', period: '2026-10', filter: '', generatedAt, items: its, labels, ...extra })

type WB = Awaited<ReturnType<typeof buildLedgerWorkbook>>
const cellsOf = (wb: WB, sheet: string, from: string, to: string): unknown[] => {
  const ws = wb.getWorksheet(sheet)!
  const col = from.match(/^[A-Z]+/)![0]
  const out: unknown[] = []
  for (let r = Number(from.replace(/^[A-Z]+/, '')); r <= Number(to.replace(/^[A-Z]+/, '')); r++) out.push(ws.getCell(`${col}${r}`).value)
  return out
}
/** What a spreadsheet app shows: numbers as they are; SUMIF, SUMIFS, COUNTIF and SUM evaluated. */
function shown(wb: WB, sheet: string, v: unknown): number {
  if (typeof v === 'number') return v
  const f = (v as { formula?: string } | undefined)?.formula ?? ''
  const range = (ref: string) => { const m = /^(?:(\w+)!)?([A-Z]+\d+):([A-Z]+\d+)$/.exec(ref)!; return cellsOf(wb, m[1] ?? sheet, m[2]!, m[3]!) }
  let m: RegExpExecArray | null
  if ((m = /^SUM\(([^)]+)\)$/.exec(f))) return range(m[1]!).reduce<number>((a, x) => a + shown(wb, sheet, x), 0)
  if ((m = /^SUMIF\(([^,]+),"([^"]*)",([^)]+)\)$/.exec(f))) {
    const c = range(m[1]!); const vals = range(m[3]!)
    return vals.reduce<number>((a, x, i) => a + (c[i] === m![2] ? Number(x) : 0), 0)
  }
  if ((m = /^COUNTIF\(([^,]+),"([^"]*)"\)$/.exec(f))) return range(m[1]!).filter((x) => x === m![2]).length
  if ((m = /^SUMIFS\(([^,]+),(.+)\)$/.exec(f))) {
    const vals = range(m[1]!)
    const pairs = m[2]!.split(/,(?=[^"]*(?:"[^"]*"[^"]*)*$)/)
    const crit: Array<[unknown[], string]> = []
    for (let i = 0; i < pairs.length; i += 2) crit.push([range(pairs[i]!), pairs[i + 1]!.replace(/^"|"$/g, '')])
    return vals.reduce<number>((a, x, i) => a + (crit.every(([c, want]) => c[i] === want) ? Number(x) : 0), 0)
  }
  if ((m = /^([A-Z]+\d+)((?:-[A-Z]+\d+)+)$/.exec(f))) return m[2]!.split('-').filter(Boolean).reduce((a, ref) => a - shown(wb, sheet, wb.getWorksheet(sheet)!.getCell(ref).value), shown(wb, sheet, wb.getWorksheet(sheet)!.getCell(m[1]!).value))
  if ((m = /^(\w+)!([A-Z]+\d+)-([A-Z]+\d+)$/.exec(f))) return shown(wb, m[1]!, wb.getWorksheet(m[1]!)!.getCell(m[2]!).value) - shown(wb, sheet, wb.getWorksheet(sheet)!.getCell(m[3]!).value)
  throw new Error(`not a formula this test evaluates: ${f}`)
}
function summaryValue(wb: WB, label: string): unknown {
  let found: unknown
  wb.getWorksheet('Summary')!.eachRow((row) => { if (row.getCell(1).value === label) found = row.getCell(2).value })
  return found
}

describe('the Summary reads like the accountant’s own', () => {
  it('sums the outflows by kind and counts the entries by state, live over Movements', async () => {
    const wb = await buildLedgerWorkbook(data(items))
    expect(shown(wb, 'Summary', summaryValue(wb, 'Outflows: payments'))).toBe(1.5)
    expect(shown(wb, 'Summary', summaryValue(wb, 'Outflows: payrolls'))).toBe(0.75)
    expect(shown(wb, 'Summary', summaryValue(wb, 'Confirmed'))).toBe(3)
    expect(shown(wb, 'Summary', summaryValue(wb, 'Awaiting'))).toBe(1)
    expect(shown(wb, 'Summary', summaryValue(wb, 'Refused'))).toBe(1)
  })
  it('states the position, what is committed, what is confirming, and available as the visible subtraction', async () => {
    const wb = await buildLedgerWorkbook(data(items, { balance: { totalZec: 10, reservedZec: 0.5, confirmingZec: 0.5, overCommitted: false } }))
    expect(summaryValue(wb, 'Position (total)')).toBe(10)
    expect(summaryValue(wb, 'Committed to open proposals')).toBe(0.5)
    expect(summaryValue(wb, 'Confirming')).toBe(0.5)
    expect(shown(wb, 'Summary', summaryValue(wb, 'Available'))).toBe(9)
    expect(summaryValue(wb, 'Balance as of')).toBe('2026-10-31 12:00 UTC')
    expect(summaryValue(wb, 'Over-committed')).toBeUndefined()
  })
  it('lets available go negative and says so when open proposals exceed what can be spent', async () => {
    const wb = await buildLedgerWorkbook(data(items, { balance: { totalZec: 1, reservedZec: 3, confirmingZec: 0, overCommitted: true } }))
    expect(shown(wb, 'Summary', summaryValue(wb, 'Available'))).toBe(-2)
    expect(summaryValue(wb, 'Over-committed')).toBe('')
  })
  it('names the row of a payroll whose lines were not read, instead of a nameless row holding ZEC', async () => {
    const wb = await buildLedgerWorkbook(data([item({ kind: 'Payroll', address: '', zec: 2 })]))
    const ws = wb.getWorksheet('By beneficiary')!
    expect(ws.getCell('A2').value).toBe('No address')
    expect(shown(wb, 'By beneficiary', ws.getCell('C2').value)).toBe(2)
  })
  it('says nothing about the balance when it could not be read', async () => {
    const wb = await buildLedgerWorkbook(data(items))
    expect(summaryValue(wb, 'Position (total)')).toBeUndefined()
  })
})

describe('the By beneficiary sheet', () => {
  it('has one row per address, named from the registry or the line, summing settled and open by live formulas', async () => {
    const wb = await buildLedgerWorkbook(data(items, { payeeNames: { u1rent: 'Landlord' } }))
    const ws = wb.getWorksheet('By beneficiary')!
    const rows: Array<[unknown, unknown, number, number, number]> = []
    for (let r = 2; r <= 4; r++) rows.push([ws.getCell(`A${r}`).value, ws.getCell(`B${r}`).value, shown(wb, 'By beneficiary', ws.getCell(`C${r}`).value), shown(wb, 'By beneficiary', ws.getCell(`D${r}`).value), shown(wb, 'By beneficiary', ws.getCell(`E${r}`).value)])
    expect(rows).toEqual([
      ['Landlord', 'u1rent', 1.5, 0, 2], // the refused entry counts as an entry, not as money
      ['Ana', 'u1ana', 0.5, 0.5, 2],
      ['Bia', 'u1bia', 0.25, 0, 1],
    ])
  })
  it('totals the sheet and shows the difference against the Summary as a live formula', async () => {
    const wb = await buildLedgerWorkbook(data(items))
    const ws = wb.getWorksheet('By beneficiary')!
    const total = ws.getRow(5)
    expect(total.getCell(1).value).toBe('TOTAL')
    expect(shown(wb, 'By beneficiary', total.getCell(3).value)).toBe(2.25)
    expect(shown(wb, 'By beneficiary', total.getCell(4).value)).toBe(0.5)
    const diff = ws.getRow(6)
    expect(diff.getCell(1).value).toBe('Difference vs Summary')
    expect((diff.getCell(3).value as { formula: string }).formula).toMatch(/^Summary!/)
    expect(shown(wb, 'By beneficiary', diff.getCell(3).value)).toBe(0)
    expect(shown(wb, 'By beneficiary', diff.getCell(4).value)).toBe(0)
  })
  it('writes zeros, not formulas, for an empty book', async () => {
    const wb = await buildLedgerWorkbook(data([]))
    const ws = wb.getWorksheet('By beneficiary')!
    expect(ws.getRow(2).getCell(1).value).toBe('TOTAL')
    expect(ws.getRow(2).getCell(3).value).toBe(0)
    expect(summaryValue(wb, 'Outflows: payments')).toBe(0)
  })
})
