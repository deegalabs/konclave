// Formatted .xlsx ledger export. exceljs is heavy, so it is loaded LAZILY (dynamic import) only
// when the user actually exports - it never enters the main bundle. The workbook is a real,
// accountant-ready document: a Summary sheet with live SUM/SUMIF formulas over an itemized
// Movements sheet (a payment = 1 row; a payroll = one row per beneficiary), styled headers,
// frozen header row, ZEC number format, and a totals row. Nothing here touches secrets or the
// network: it works entirely from the ledger data the caller already has.
//
// #302: every row carries its memo and its txid (linked to the public explorer), so whoever holds
// the workbook can tie a row to the chain; the Summary names the active filter when the export is
// a part of the book; an empty book writes zeros where a formula would have pointed at itself; and
// the file's hidden properties carry no author and no time the Summary does not show. The Summary's
// "Open" counts only the rows that can still move (awaiting or ready), on an Open column of their
// own: a refused or expired row is neither settled nor open, so it enters neither total. Who
// proposed and who approved travel on each row as the vault records them; when each approval was
// given is not recorded yet (#290), so the sheet does not pretend to know it.

import type { Workbook } from 'exceljs'
import { explorerTxUrl } from './format'

export interface LedgerXlsxItem {
  dateISO: string // yyyy-mm-dd (sortable, locale-neutral in the cell)
  document: string // memo / payment or payroll label
  kind: string // localized "Payment" / "Payroll"
  beneficiary: string // '' for a single payment; the line label for a payroll row
  address: string
  memo: string // this row's memo: the payment's, or the payroll line's (#302)
  proposer: string // who proposed, as the vault records it
  approvers: string // who approved, names joined with ', '; '' until somebody has
  state: string // localized state label
  settled: boolean // sent/confirmed → counts toward "settled out"
  open: boolean // awaiting/ready → counts toward "open"; a refused or expired row is neither
  zec: number // outflow for this row, in ZEC with all 8 places (from integer zatoshi, #303)
  txid: string // '' until the proposal was sent; a payroll's rows share one (#302)
}

export interface LedgerXlsxData {
  vaultName: string
  period: string
  /** The active filters' labels when the export is a part of the book; '' for the whole book (#302). */
  filter: string
  generatedAt: Date
  items: LedgerXlsxItem[]
  labels: {
    // localized column/section headers so the sheet matches the UI language
    summary: string
    movements: string
    vault: string
    period: string
    filter: string
    generated: string
    entries: string
    settledOut: string
    open: string
    colDate: string
    colDocument: string
    colKind: string
    colBeneficiary: string
    colAddress: string
    colMemo: string
    colProposedBy: string
    colApprovedBy: string
    colState: string
    colSettled: string
    colOpen: string
    colValue: string
    colTxid: string
    total: string
    yes: string
    no: string
  }
}

/** Build the workbook. No DOM here, so a test can read it back; `exportLedgerXlsx` hands it to the browser. */
export async function buildLedgerWorkbook(data: LedgerXlsxData): Promise<Workbook> {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof import('exceljs') }).default ?? mod
  const wb = new ExcelJS.Workbook()
  // No tool metadata in a generated file: no author, and both hidden dates are the "Generated"
  // time the Summary shows. (The library still names Microsoft Excel as the application in
  // docProps/app.xml; that line is not reachable through its API.)
  wb.created = data.generatedAt
  wb.modified = data.generatedAt
  const L = data.labels
  const n = data.items.length

  const columns = [
    { header: L.colDate, key: 'date', width: 13 },
    { header: L.colDocument, key: 'document', width: 30 },
    { header: L.colKind, key: 'kind', width: 12 },
    { header: L.colBeneficiary, key: 'beneficiary', width: 22 },
    { header: L.colAddress, key: 'address', width: 30 },
    { header: L.colMemo, key: 'memo', width: 30 },
    { header: L.colProposedBy, key: 'proposer', width: 16 },
    { header: L.colApprovedBy, key: 'approvers', width: 24 },
    { header: L.colState, key: 'state', width: 12 },
    { header: L.colSettled, key: 'settled', width: 10 },
    { header: L.colOpen, key: 'open', width: 10 },
    { header: L.colValue, key: 'zec', width: 14 },
    { header: L.colTxid, key: 'txid', width: 66 },
  ]
  // A column's letter comes from the list above, so adding a column cannot leave a formula on the
  // wrong one.
  const letter = (key: string) => String.fromCharCode(65 + columns.findIndex((c) => c.key === key))
  const settledCol = letter('settled')
  const openCol = letter('open')
  const valueCol = letter('zec')

  // Row math is deterministic from the item count, so the Summary formulas can be written before
  // the Movements rows exist (an .xlsx formula is just a string resolved by the spreadsheet app).
  // The header is row 1 and the data rows run from 2 to n + 1. With no rows, a formula over "the
  // data" would point at the total row itself, which Excel opens as a circular reference: an empty
  // book gets the number 0 instead.
  const firstData = 2
  const lastData = firstData + n - 1
  const sheet = (name: string) => (/\s/.test(name) ? `'${name}'` : name) // quote a sheet name only if it has spaces
  const MV = sheet(L.movements)
  const span = (col: string) => `${col}${firstData}:${col}${lastData}`
  const sumIf = (col: string, yesNo: string) => (n === 0 ? 0 : { formula: `SUMIF(${MV}!${span(col)},"${yesNo}",${MV}!${span(valueCol)})` })

  // ---- Summary sheet (first tab) with live formulas referencing Movements ----
  const sm = wb.addWorksheet(L.summary)
  sm.columns = [{ key: 'k', width: 20 }, { key: 'v', width: 34 }]
  const put = (k: string, v: string | number | { formula: string }, opts?: { money?: boolean; bold?: boolean }) => {
    const row = sm.addRow({ k, v })
    row.getCell('k').font = { bold: true }
    if (opts?.bold) row.getCell('v').font = { bold: true }
    if (opts?.money) row.getCell('v').numFmt = '0.00000000'
    return row
  }
  const titleRow = sm.addRow({ k: 'Konclave', v: L.summary })
  titleRow.font = { bold: true }
  sm.addRow({})
  put(L.vault, data.vaultName)
  put(L.period, data.period)
  if (data.filter) put(L.filter, data.filter)
  put(L.generated, data.generatedAt.toISOString().slice(0, 16).replace('T', ' '))
  put(L.entries, n)
  sm.addRow({})
  put(L.settledOut, sumIf(settledCol, L.yes), { money: true, bold: true })
  put(L.open, sumIf(openCol, L.yes), { money: true, bold: true })

  // ---- Movements sheet (itemized) ----
  const mv = wb.addWorksheet(L.movements, { views: [{ state: 'frozen', ySplit: 1 }] })
  mv.columns = columns
  for (const it of data.items) {
    const row = mv.addRow({
      date: it.dateISO,
      document: it.document,
      kind: it.kind,
      beneficiary: it.beneficiary,
      address: it.address,
      memo: it.memo,
      proposer: it.proposer,
      approvers: it.approvers,
      state: it.state,
      settled: it.settled ? L.yes : L.no,
      open: it.open ? L.yes : L.no,
      zec: it.zec,
      txid: it.txid,
    })
    if (it.txid) row.getCell('txid').value = { text: it.txid, hyperlink: explorerTxUrl(it.txid) }
  }
  // The TOTAL row agrees with the summary: what moved plus what can still move. A plain SUM of the
  // column added the refused and expired rows, whose money never left and which enter neither
  // summary total, so the sheet's own total disagreed with both of them.
  const sumIfHere = (col: string) => `SUMIF(${span(col)},"${L.yes}",${span(valueCol)})`
  const totalRow = mv.addRow({ document: L.total, zec: n === 0 ? 0 : { formula: `${sumIfHere(settledCol)}+${sumIfHere(openCol)}` } })
  const header = mv.getRow(1)
  header.font = { bold: true }
  header.alignment = { vertical: 'middle' }
  totalRow.font = { bold: true }
  mv.getColumn('zec').numFmt = '0.00000000'
  mv.getColumn('zec').alignment = { horizontal: 'right' }
  totalRow.getCell('zec').numFmt = '0.00000000'
  return wb
}

/** Build the workbook and trigger a download. Returns once the file has been handed to the browser. */
export async function exportLedgerXlsx(data: LedgerXlsxData): Promise<void> {
  const wb = await buildLedgerWorkbook(data)
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
