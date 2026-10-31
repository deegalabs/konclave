import { describe, expect, it } from 'vitest'
import { buildLedgerWorkbook, type LedgerXlsxData, type LedgerXlsxItem } from './ledgerXlsx'
import { explorerTxUrl } from './format'

// #302: the XLSX is the export meant for the accountant. It carried no txid and no memo, so no row
// could be tied to the chain; an empty book wrote a total that summed itself; and the file named
// the app as its author in the hidden properties. These build the workbook (no browser needed) and
// read the cells, and one writes the file and loads it back to check what the hidden properties say.

const labels: LedgerXlsxData['labels'] = {
  summary: 'Summary', movements: 'Movements', vault: 'Vault', period: 'Period', filter: 'Filter',
  generated: 'Generated', entries: 'Entries', settledOut: 'Settled out', open: 'Open',
  colDate: 'Date', colDocument: 'Document', colKind: 'Kind', colBeneficiary: 'Beneficiary',
  colAddress: 'Address', colMemo: 'Memo', colState: 'State', colSettled: 'Settled', colOpen: 'Open', colValue: 'Value',
  colTxid: 'Transaction (txid)', total: 'TOTAL', yes: 'yes', no: 'no',
}
const TXID = 'a'.repeat(64)
const item = (over: Partial<LedgerXlsxItem> = {}): LedgerXlsxItem => ({
  dateISO: '2026-10-01', document: 'Rent', kind: 'Payment', beneficiary: '', address: 'u1rent',
  memo: '', state: 'confirmed', settled: true, open: false, zec: 1.5, txid: '', ...over,
})
const generatedAt = new Date('2026-10-29T12:34:56Z')
const data = (items: LedgerXlsxItem[], filter = ''): LedgerXlsxData => ({ vaultName: 'Caixa', period: '2026-10-01', filter, generatedAt, items, labels })

/** The value next to a label on the Summary sheet, or undefined when the label is not there. */
function summaryValue(wb: Awaited<ReturnType<typeof buildLedgerWorkbook>>, label: string): unknown {
  const sm = wb.getWorksheet('Summary')!
  let found: unknown
  // By column number: a workbook read back from a file has no column keys.
  sm.eachRow((row) => { if (row.getCell(1).value === label) found = row.getCell(2).value })
  return found
}

/**
 * What a spreadsheet app shows for a Summary cell: a number as is, or a SUMIF formula evaluated
 * over the Movements cells, so a test asserts the figure and not which column the formula names.
 */
function shown(wb: Awaited<ReturnType<typeof buildLedgerWorkbook>>, v: unknown): number {
  if (typeof v === 'number') return v
  const f = (v as { formula?: string } | undefined)?.formula ?? ''
  const cells = (sheet: string, from: string, to: string): unknown[] => {
    const ws = wb.getWorksheet(sheet)!
    const out: unknown[] = []
    for (let r = Number(from.slice(1)); r <= Number(to.slice(1)); r++) out.push(ws.getCell(`${from[0]}${r}`).value)
    return out
  }
  const m = /^SUMIF\((\w+)!([A-Z]\d+):([A-Z]\d+),"([^"]*)",(\w+)!([A-Z]\d+):([A-Z]\d+)\)$/.exec(f)
  if (!m) throw new Error(`not a formula this test evaluates: ${f}`)
  const [, cSheet = '', cFrom = '', cTo = '', crit = '', vSheet = '', vFrom = '', vTo = ''] = m
  const crits = cells(cSheet, cFrom, cTo)
  const vals = cells(vSheet, vFrom, vTo)
  return vals.reduce<number>((acc, x, i) => acc + (crits[i] === crit ? Number(x) : 0), 0)
}

describe('the XLSX ledger export (#302)', () => {
  it('gives every movement its memo and its txid, linked to the public explorer', async () => {
    const wb = await buildLedgerWorkbook(data([
      item({ memo: 'October rent', txid: TXID }),
      item({ document: 'Payroll', kind: 'Payroll', beneficiary: 'Alice', address: 'u1alice', memo: 'Alice Oct', state: 'awaiting', settled: false, open: true, zec: 0.25 }),
    ]))
    const mv = wb.getWorksheet('Movements')!
    expect((mv.getRow(1).values as unknown[]).slice(1)).toEqual([
      'Date', 'Document', 'Kind', 'Beneficiary', 'Address', 'Memo', 'State', 'Settled', 'Open', 'Value', 'Transaction (txid)',
    ])
    expect(mv.getRow(2).getCell('memo').value).toBe('October rent')
    expect(mv.getRow(2).getCell('txid').value).toMatchObject({ text: TXID, hyperlink: explorerTxUrl(TXID) })
    expect(mv.getRow(3).getCell('memo').value).toBe('Alice Oct')
    expect(mv.getRow(3).getCell('txid').value ?? '').toBe('') // not sent: no txid, no link
  })

  it('sums the rows that moved or can still move, on the sheet and in the summary, whatever the columns are', async () => {
    // Three rows: settled, open, and a refused one whose money never left. The sheet's TOTAL row
    // used to SUM the whole value column, so it added the refused row that neither summary total
    // counts, and disagreed with both of them. It is now the two summary totals added together.
    const wb = await buildLedgerWorkbook(data([
      item(), item({ settled: false, open: true, state: 'awaiting', zec: 0.25 }), item({ settled: false, open: false, state: 'rejected', zec: 0.5 }),
    ]))
    const mv = wb.getWorksheet('Movements')!
    const total = mv.getRow(5) // header, three rows, total
    expect(total.getCell('document').value).toBe('TOTAL')
    expect(total.getCell('zec').formula).toBe('SUMIF(H2:H4,"yes",J2:J4)+SUMIF(I2:I4,"yes",J2:J4)')
    expect(summaryValue(wb, 'Settled out')).toMatchObject({ formula: 'SUMIF(Movements!H2:H4,"yes",Movements!J2:J4)' })
    expect(summaryValue(wb, 'Open')).toMatchObject({ formula: 'SUMIF(Movements!I2:I4,"yes",Movements!J2:J4)' })
    expect(summaryValue(wb, 'Entries')).toBe(3)
  })

  it('writes zeros, not formulas, for an empty book, so nothing sums itself', async () => {
    const wb = await buildLedgerWorkbook(data([]))
    const mv = wb.getWorksheet('Movements')!
    const total = mv.getRow(2) // the total row is the first row under the header
    expect(total.getCell('document').value).toBe('TOTAL')
    expect(total.getCell('zec').value).toBe(0)
    expect(total.getCell('zec').formula).toBeFalsy()
    expect(summaryValue(wb, 'Settled out')).toBe(0)
    expect(summaryValue(wb, 'Open')).toBe(0)
  })

  it('names the active filter on the summary only when the export is a part of the book', async () => {
    expect(summaryValue(await buildLedgerWorkbook(data([item()], 'Settled · Payments')), 'Filter')).toBe('Settled · Payments')
    expect(summaryValue(await buildLedgerWorkbook(data([item()])), 'Filter')).toBeUndefined()
  })

  it('carries no author and no time the summary does not show, once written and read back', async () => {
    const wb = await buildLedgerWorkbook(data([item()]))
    const buf = await wb.xlsx.writeBuffer()
    const mod = await import('exceljs')
    const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
    const back = new ExcelJS.Workbook()
    await back.xlsx.load(buf as ArrayBuffer)
    // The library writes "Unknown" where there is no author; what must not be there is the app.
    expect(['Unknown', '', undefined]).toContain(back.creator)
    expect(['Unknown', '', undefined]).toContain(back.lastModifiedBy)
    expect(back.created.getTime()).toBe(generatedAt.getTime())
    expect(back.modified.getTime()).toBe(generatedAt.getTime())
    expect(summaryValue(back, 'Generated')).toBe('2026-10-29 12:34')
  })
  it('shows every amount to the zatoshi: eight decimals on the rows, the total and the summary (#303)', async () => {
    const wb = await buildLedgerWorkbook(data([item({ zec: 0.00001234, settled: true })]))
    const mv = wb.getWorksheet('Movements')!
    expect(mv.getColumn('zec').numFmt).toBe('0.00000000')
    expect(mv.getRow(3).getCell('zec').numFmt).toBe('0.00000000') // the total row
    const sm = wb.getWorksheet('Summary')!
    let fmt: string | undefined
    sm.eachRow((row) => { if (row.getCell(1).value === 'Settled out') fmt = row.getCell(2).numFmt })
    expect(fmt).toBe('0.00000000')
  })

  it('counts as open only what can still move: a refused or expired row is neither settled nor open', async () => {
    const wb = await buildLedgerWorkbook(data([
      item(), // confirmed, 1.5: settled
      item({ state: 'awaiting', settled: false, open: true, zec: 0.25 }), // still able to move
      item({ state: 'rejected', settled: false, open: false, zec: 0.75 }), // closed, no money moved
      item({ state: 'expired', settled: false, open: false, zec: 0.5 }),
    ]))
    expect(shown(wb, summaryValue(wb, 'Settled out'))).toBe(1.5)
    expect(shown(wb, summaryValue(wb, 'Open'))).toBe(0.25)
  })
})
