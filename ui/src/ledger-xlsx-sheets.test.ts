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
  overCommitted: 'Over-committed', noAddress: 'No address recorded',
  unreadPayrolls: 'Payrolls whose lines could not be read', balanceUnread: 'Balance could not be read',
}
const item = (over: Partial<LedgerXlsxItem> = {}): LedgerXlsxItem => ({
  dateISO: '2026-10-01', document: 'Rent', kind: 'Payment', beneficiary: '', address: 'u1rent',
  memo: '', proposer: 'Alice', approvers: 'Alice, Bob', state: 'confirmed', settled: true, open: false, value_zat: 150000000, txid: '', ...over,
})
const items = [
  item(),                                                                                   // rent, settled 1.5
  item({ document: 'October', kind: 'Payroll', beneficiary: 'Ana', address: 'u1ana', value_zat: 50000000 }), // settled
  item({ document: 'October', kind: 'Payroll', beneficiary: 'Bia', address: 'u1bia', value_zat: 25000000 }),
  item({ document: 'November', kind: 'Payroll', beneficiary: 'Ana', address: 'u1ana', value_zat: 50000000, state: 'awaiting', settled: false, open: true }),
  item({ document: 'Refused', address: 'u1rent', value_zat: 900000000, state: 'refused', settled: false, open: false }),
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
  // A criterion as the spreadsheet reads it: quotes doubled, a leading "=" forcing equality, and
  // ~ escaping the wildcards * and ?.
  const want = (raw: string) => {
    let c = raw.replace(/^"|"$/g, '').replace(/""/g, '"')
    if (/^=[=<>]/.test(c)) c = c.slice(1)
    return c.replace(/~([~*?])/g, '$1')
  }
  const pairsOf = (args: string) => {
    const parts = args.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    const crit: Array<[unknown[], string]> = []
    for (let i = 0; i < parts.length; i += 2) crit.push([range(parts[i]!), want(parts[i + 1]!)])
    return crit
  }
  // Two functions added, as in a count of settled rows plus a count of open rows.
  const sumOf = f.split(/(?<=\))\+(?=[A-Z])/)
  if (sumOf.length > 1) return sumOf.reduce<number>((a, part) => a + shown(wb, sheet, { formula: part }), 0)
  let m: RegExpExecArray | null
  if ((m = /^SUM\(([^)]+)\)$/.exec(f))) return range(m[1]!).reduce<number>((a, x) => a + shown(wb, sheet, x), 0)
  if ((m = /^SUMIF\(([^,]+),("(?:[^"]|"")*"),([^)]+)\)$/.exec(f))) {
    const c = range(m[1]!); const vals = range(m[3]!); const w = want(m[2]!)
    return vals.reduce<number>((a, x, i) => a + (c[i] === w ? Number(x) : 0), 0)
  }
  if ((m = /^COUNTIF\(([^,]+),("(?:[^"]|"")*")\)$/.exec(f))) { const w = want(m[2]!); return range(m[1]!).filter((x) => x === w).length }
  if ((m = /^SUMIFS\(([^,]+),(.+)\)$/.exec(f))) {
    const vals = range(m[1]!)
    const crit = pairsOf(m[2]!)
    return vals.reduce<number>((a, x, i) => a + (crit.every(([c, w]) => (c[i] ?? '') === w) ? Number(x) : 0), 0)
  }
  if ((m = /^COUNTIFS\((.+)\)$/.exec(f))) {
    const crit = pairsOf(m[1]!)
    return crit[0]![0].filter((_, i) => crit.every(([c, w]) => (c[i] ?? '') === w)).length
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
  it('says the balance could not be read instead of dropping the block in silence', async () => {
    const wb = await buildLedgerWorkbook(data(items))
    expect(summaryValue(wb, 'Position (total)')).toBeUndefined()
    expect(summaryValue(wb, 'Balance could not be read')).toBe('')
  })
  it('escapes the words it matches on, so a quote or a wildcard in a state still counts its own rows', async () => {
    const wb = await buildLedgerWorkbook(data([item({ state: 'odd "state" *', value_zat: 1 }), item({ state: 'odd "state" x', value_zat: 2 })]))
    const v = summaryValue(wb, 'Odd "state" *') as { formula: string }
    expect(v.formula).toBe('COUNTIF(Movements!I2:I3,"odd ""state"" ~*")')
    expect(shown(wb, 'Summary', v)).toBe(1)
  })
})

describe('the By beneficiary sheet', () => {
  it('has one row per address, named from the registry or the line, summing settled and open by live formulas', async () => {
    const wb = await buildLedgerWorkbook(data(items, { registry: [{ id: '1', name: 'Landlord', address: 'u1rent', memo: '', is_public: false }] }))
    const ws = wb.getWorksheet('By beneficiary')!
    const rows: Array<[unknown, unknown, number, number, number]> = []
    for (let r = 2; r <= 4; r++) rows.push([ws.getCell(`A${r}`).value, ws.getCell(`B${r}`).value, shown(wb, 'By beneficiary', ws.getCell(`C${r}`).value), shown(wb, 'By beneficiary', ws.getCell(`D${r}`).value), shown(wb, 'By beneficiary', ws.getCell(`E${r}`).value)])
    expect(rows).toEqual([
      ['Landlord', 'u1rent', 1.5, 0, 1], // the refused entry is in neither total, so not an entry here
      ['Ana', 'u1ana', 0.5, 0.5, 2],
      ['Bia', 'u1bia', 0.25, 0, 1],
    ])
  })
  it('follows the book by beneficiary: closed-only addresses left out, the first name kept, sorted in whole zatoshi', async () => {
    // The same rule as the screen (pivotByPayee): an address with only refused or expired entries has
    // nothing settled or open; the first label seen names the row; and 0.1 + 0.2 ties with 0.3,
    // which a floating-point sort would put first.
    const wb = await buildLedgerWorkbook(data([
      item({ address: 'u1three', beneficiary: 'Tri', value_zat: 30000000 }),
      item({ kind: 'Payroll', address: 'u1sum', beneficiary: 'Ana', value_zat: 10000000 }),
      item({ kind: 'Payroll', address: 'u1sum', beneficiary: 'Ana L.', value_zat: 20000000 }),
      item({ address: 'u1gone', value_zat: 900000000, state: 'expired', settled: false, open: false }),
    ]))
    const ws = wb.getWorksheet('By beneficiary')!
    expect([ws.getCell('A2').value, ws.getCell('A3').value, ws.getCell('A4').value]).toEqual(['Tri', 'Ana', 'TOTAL'])
  })
  it('names a payment with no address, and leaves an unread payroll out of the sheet with its count said', async () => {
    // Both rows have no address on Movements; only the payment belongs to the "no address" row. The
    // payroll is in the Summary at its own value and not here, so the difference names it.
    const wb = await buildLedgerWorkbook(data([
      item({ address: '', value_zat: 70000000 }),
      item({ kind: 'Payroll', document: 'Unread', address: '', unread: true, value_zat: 200000000 }),
    ]))
    const ws = wb.getWorksheet('By beneficiary')!
    expect(ws.getCell('A2').value).toBe('No address recorded')
    expect(shown(wb, 'By beneficiary', ws.getCell('C2').value)).toBe(0.7)
    expect(shown(wb, 'By beneficiary', ws.getCell('E2').value)).toBe(1)
    // and the value stored beside each formula says the same, not the payroll added in
    expect((ws.getCell('C2').value as { result: number }).result).toBe(0.7)
    expect((ws.getCell('E2').value as { result: number }).result).toBe(1)
    expect(ws.getCell('A3').value).toBe('TOTAL')
    expect(ws.getCell('A4').value).toBe('Difference vs Summary')
    expect(shown(wb, 'By beneficiary', ws.getCell('C4').value)).toBe(2)
    expect(ws.getCell('A5').value).toBe('Payrolls whose lines could not be read')
    expect(ws.getCell('C5').value).toBe(1)
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

describe('every formula carries the value it computes (#812)', () => {
  it('on all three sheets, equal to what the formula evaluates to', async () => {
    // A viewer that does not recalculate (Excel's Protected View, a phone previewer) shows the
    // stored value, so a formula without one is a blank cell there. Checked cell by cell against
    // the formula's own evaluation, so a new formula without a value fails here. Read through
    // cell.result: ExcelJS writes a zero as <v>0</v>, but cell.value leaves out a zero result, so
    // reading the value would report every zero as missing.
    // Rows of 0.07 and 0.01 on addresses of their own, so a floating-point sum of the rows drifts
    // (1.8 + 0.5 + 0.25 + 0.07 + 0.01 is 2.6299999999999994 that way), and an unread payroll, which the
    // Summary counts and the sheet does not.
    const wb = await buildLedgerWorkbook(data([...items, item({ value_zat: 10000000 }), item({ value_zat: 20000000 }),
      item({ address: 'u1seven', value_zat: 7000000 }), item({ address: 'u1one', value_zat: 1000000 }),
      item({ kind: 'Payroll', address: '', unread: true, value_zat: 30000000 })], {
      balance: { totalZec: 10, reservedZec: 0.5, confirmingZec: 0.1, overCommitted: false },
    }))
    let formulas = 0
    for (const name of ['Summary', 'Movements', 'By beneficiary']) {
      wb.getWorksheet(name)!.eachRow((row) => row.eachCell((cell) => {
        const v = cell.value as { formula?: string } | null
        if (!v || typeof v !== 'object' || !('formula' in v)) return
        formulas++
        const result = (cell as unknown as { result: unknown }).result
        expect(typeof result, `${name}!${cell.address} ${v.formula}`).toBe('number')
        // The Movements TOTAL (two SUMIFs added) has its own value test beside #812's.
        // Exact to the zatoshi: the stored value is the canonical 8-decimal figure (a floating-point
        // sum such as 2.5500000000000003 is not), and it is the formula's own value.
        expect(result, `${name}!${cell.address} stored`).toBe(Math.round((result as number) * 1e8) / 1e8)
        if (name !== 'Movements') expect(Math.round((result as number) * 1e8), `${name}!${cell.address}`).toBe(Math.round(shown(wb, name, v) * 1e8))
      }))
    }
    expect(formulas).toBeGreaterThan(15)
    expect(summaryValue(wb, 'Available')).toMatchObject({ result: 9.4 })
  })
})
