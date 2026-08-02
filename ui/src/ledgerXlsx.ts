// Formatted .xlsx ledger export. exceljs is heavy, so it is loaded LAZILY (dynamic import) only
// when the user actually exports — it never enters the main bundle. The workbook is a real,
// accountant-ready document: a Summary sheet with live SUM/SUMIF formulas over an itemized
// Movements sheet (a payment = 1 row; a payroll = one row per beneficiary), styled headers,
// frozen header row, ZEC number format, and a totals row. Nothing here touches secrets or the
// network: it works entirely from the ledger data the caller already has.

export interface LedgerXlsxItem {
  dateISO: string // yyyy-mm-dd (sortable, locale-neutral in the cell)
  document: string // memo / payment or payroll label
  kind: string // localized "Payment" / "Payroll"
  beneficiary: string // '' for a single payment; the line label for a payroll row
  address: string
  state: string // localized state label
  settled: boolean // sent/confirmed → counts toward "settled out"
  zec: number // outflow for this row
}

export interface LedgerXlsxData {
  vaultName: string
  period: string
  generatedISO: string
  items: LedgerXlsxItem[]
  labels: {
    // localized column/section headers so the sheet matches the UI language
    summary: string
    movements: string
    vault: string
    period: string
    generated: string
    entries: string
    settledOut: string
    open: string
    colDate: string
    colDocument: string
    colKind: string
    colBeneficiary: string
    colAddress: string
    colState: string
    colSettled: string
    colValue: string
    total: string
    yes: string
    no: string
  }
}

/** Build the workbook and trigger a download. Returns once the file has been handed to the browser. */
export async function exportLedgerXlsx(data: LedgerXlsxData): Promise<void> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Konclave'
  const L = data.labels

  // Row math is deterministic from the item count, so the Summary formulas can be written before
  // the Movements rows exist (an .xlsx formula is just a string resolved by the spreadsheet app).
  const firstData = 2
  const lastData = Math.max(firstData, 1 + data.items.length) // header is row 1
  const settledCol = 'G' // "Settled" column on Movements
  const valueCol = 'H'
  const sheet = (n: string) => (/\s/.test(n) ? `'${n}'` : n) // quote a sheet name only if it has spaces
  const MV = sheet(L.movements)

  // ---- Summary sheet (first tab) with live formulas referencing Movements ----
  const sm = wb.addWorksheet(L.summary)
  sm.columns = [{ key: 'k', width: 20 }, { key: 'v', width: 34 }]
  const put = (k: string, v: string | number | { formula: string }, opts?: { money?: boolean; bold?: boolean }) => {
    const row = sm.addRow({ k, v })
    row.getCell('k').font = { bold: true }
    if (opts?.bold) row.getCell('v').font = { bold: true }
    if (opts?.money) row.getCell('v').numFmt = '0.0000'
    return row
  }
  const titleRow = sm.addRow({ k: 'Konclave', v: L.summary })
  titleRow.font = { bold: true }
  sm.addRow({})
  put(L.vault, data.vaultName)
  put(L.period, data.period)
  put(L.generated, data.generatedISO)
  put(L.entries, data.items.length)
  sm.addRow({})
  put(L.settledOut, { formula: `SUMIF(${MV}!${settledCol}${firstData}:${settledCol}${lastData},"${L.yes}",${MV}!${valueCol}${firstData}:${valueCol}${lastData})` }, { money: true, bold: true })
  put(L.open, { formula: `SUMIF(${MV}!${settledCol}${firstData}:${settledCol}${lastData},"${L.no}",${MV}!${valueCol}${firstData}:${valueCol}${lastData})` }, { money: true, bold: true })

  // ---- Movements sheet (itemized) ----
  const mv = wb.addWorksheet(L.movements, { views: [{ state: 'frozen', ySplit: 1 }] })
  mv.columns = [
    { header: L.colDate, key: 'date', width: 13 },
    { header: L.colDocument, key: 'document', width: 30 },
    { header: L.colKind, key: 'kind', width: 12 },
    { header: L.colBeneficiary, key: 'beneficiary', width: 22 },
    { header: L.colAddress, key: 'address', width: 30 },
    { header: L.colState, key: 'state', width: 12 },
    { header: L.colSettled, key: 'settled', width: 10 },
    { header: L.colValue, key: 'zec', width: 14 },
  ]
  for (const it of data.items) {
    mv.addRow({
      date: it.dateISO,
      document: it.document,
      kind: it.kind,
      beneficiary: it.beneficiary,
      address: it.address,
      state: it.state,
      settled: it.settled ? L.yes : L.no,
      zec: it.zec,
    })
  }
  const totalRow = mv.addRow({ document: L.total, zec: { formula: `SUM(${valueCol}${firstData}:${valueCol}${lastData})` } })
  const header = mv.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }
  totalRow.font = { bold: true }
  mv.getColumn('zec').numFmt = '0.0000'
  mv.getColumn('zec').alignment = { horizontal: 'right' }
  totalRow.getCell('zec').numFmt = '0.0000'

  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `konclave-${data.vaultName.replace(/[^\w-]+/g, '-').toLowerCase() || 'ledger'}.xlsx`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
