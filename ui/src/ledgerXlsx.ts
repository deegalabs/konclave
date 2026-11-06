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
import { downloadBlob } from './download'

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
  period: string // the chosen period's name when one is chosen, otherwise the span of the exported rows
  /** The active filters' labels when the export is a part of the book; '' for the whole book (#302). */
  filter: string
  generatedAt: Date
  items: LedgerXlsxItem[]
  /** The vault's balance when the export was made, in ZEC: left out when it could not be read.
   *  `reservedZec` is the whole book's open proposals, unclamped; `overCommitted` says they exceed
   *  what can be spent. Available is written as a formula over the three, so it can go negative. */
  balance?: { totalZec: number; reservedZec: number; confirmingZec: number; overCommitted: boolean }
  /** The registry's name for an address, where it has one. */
  payeeNames?: Record<string, string>
  labels: {
    // localized column/section headers so the sheet matches the UI language
    summary: string
    movements: string
    byPayee: string
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
    outPayments: string
    outPayrolls: string
    byState: string
    kindPayment: string
    kindPayroll: string
    position: string
    committed: string
    available: string
    confirming: string
    asOf: string
    difference: string
    overCommitted: string
    noAddress: string
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
  const kindCol = letter('kind')
  const addressCol = letter('address')
  const stateCol = letter('state')

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
  sm.columns = [{ key: 'k', width: 36 }, { key: 'v', width: 34 }]
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
  const settledRow = put(L.settledOut, sumIf(settledCol, L.yes), { money: true, bold: true })
  const openRow = put(L.open, sumIf(openCol, L.yes), { money: true, bold: true })
  // Outflows by kind and entries by state: the accountant's own reading of a period, as live
  // formulas over Movements like the two totals above.
  sm.addRow({})
  // Settled outflows only: a refused or expired row of either kind never left the vault.
  const outOf = (kind: string) => (n === 0 ? 0 : { formula: `SUMIFS(${MV}!${span(valueCol)},${MV}!${span(kindCol)},"${kind}",${MV}!${span(settledCol)},"${L.yes}")` })
  put(L.outPayments, outOf(L.kindPayment), { money: true })
  put(L.outPayrolls, outOf(L.kindPayroll), { money: true })
  // Rows, not proposals: a payroll counts one per line, as the Entries row does.
  if (n > 0) {
    sm.addRow({})
    const byStateRow = sm.addRow({ k: L.byState })
    byStateRow.getCell('k').font = { bold: true }
    for (const st of [...new Set(data.items.map((it) => it.state))]) {
      put(st.charAt(0).toUpperCase() + st.slice(1), { formula: `COUNTIF(${MV}!${span(stateCol)},"${st}")` })
    }
  }
  // The balance is a figure of the moment and of the whole vault, not of the rows: dated, and left
  // out when the read failed rather than written as zeros. Available is the subtraction an
  // accountant would do by hand, written as the formula so it is visible, and negative when the
  // open proposals exceed what can be spent.
  if (data.balance) {
    sm.addRow({})
    put(L.asOf, data.generatedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC')
    const pos = put(L.position, data.balance.totalZec, { money: true, bold: true })
    const com = put(L.committed, data.balance.reservedZec, { money: true })
    const conf = put(L.confirming, data.balance.confirmingZec, { money: true })
    put(L.available, { formula: `B${pos.number}-B${com.number}-B${conf.number}` }, { money: true, bold: true })
    if (data.balance.overCommitted) put(L.overCommitted, '', { bold: true })
  }

  // ---- Movements sheet (itemized) ----
  const mv = wb.addWorksheet(L.movements, { views: [{ state: 'frozen', ySplit: 1 }] })
  mv.columns = columns
  for (const it of data.items) {
    const row = mv.addRow({
      date: it.dateISO,
      document: it.document,
      kind: it.kind,
      beneficiary: it.beneficiary,
      address: it.address.trim(),
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

  // ---- By beneficiary (third tab): one row per address, live SUMIFS over Movements, and the
  // difference against the Summary as a formula the accountant can re-run ----
  const bp = wb.addWorksheet(L.byPayee, { views: [{ state: 'frozen', ySplit: 1 }] })
  bp.columns = [
    { header: L.colBeneficiary, key: 'name', width: 22 },
    { header: L.colAddress, key: 'address', width: 30 },
    { header: L.settledOut, key: 'settled', width: 16 },
    { header: L.open, key: 'open', width: 16 },
    { header: L.entries, key: 'count', width: 14 },
  ]
  const byAddr = new Map<string, { name: string; sum: number }>()
  for (const it of data.items) {
    const a = it.address.trim()
    const row = byAddr.get(a) ?? { name: '', sum: 0 }
    if (!row.name && it.beneficiary.trim()) row.name = it.beneficiary.trim()
    if (it.settled || it.open) row.sum += it.zec
    byAddr.set(a, row)
  }
  const payees = [...byAddr.entries()].sort((x, y) => y[1].sum - x[1].sum)
  const SM = sheet(L.summary)
  const q = (v: string) => v.replace(/"/g, '""')
  for (const [address, row] of payees) {
    // No address: a payment with none recorded, or a payroll whose lines could not be read and is
    // carried as one row. The bucket is named, so nobody reads a nameless row holding ZEC.
    const name = address === '' ? L.noAddress : (data.payeeNames?.[address] || row.name)
    bp.addRow({
      name,
      address,
      settled: n === 0 ? 0 : { formula: `SUMIFS(${MV}!${span(valueCol)},${MV}!${span(addressCol)},"${q(address)}",${MV}!${span(settledCol)},"${L.yes}")` },
      open: n === 0 ? 0 : { formula: `SUMIFS(${MV}!${span(valueCol)},${MV}!${span(addressCol)},"${q(address)}",${MV}!${span(openCol)},"${L.yes}")` },
      count: n === 0 ? 0 : { formula: `COUNTIF(${MV}!${span(addressCol)},"${q(address)}")` },
    })
  }
  const pFirst = 2
  const pLast = pFirst + payees.length - 1
  const pSpan = (col: string) => `${col}${pFirst}:${col}${pLast}`
  const pTotal = bp.addRow({
    name: L.total,
    settled: payees.length === 0 ? 0 : { formula: `SUM(${pSpan('C')})` },
    open: payees.length === 0 ? 0 : { formula: `SUM(${pSpan('D')})` },
    count: payees.length === 0 ? 0 : { formula: `SUM(${pSpan('E')})` },
  })
  pTotal.font = { bold: true }
  // Zero when the sheet agrees with the Summary; any other number is a difference to look into.
  const pDiff = bp.addRow({
    name: L.difference,
    settled: payees.length === 0 ? 0 : { formula: `${SM}!B${settledRow.number}-C${pTotal.number}` },
    open: payees.length === 0 ? 0 : { formula: `${SM}!B${openRow.number}-D${pTotal.number}` },
  })
  pDiff.font = { italic: true }
  bp.getRow(1).font = { bold: true }
  for (const key of ['settled', 'open']) {
    bp.getColumn(key).numFmt = '0.00000000'
    bp.getColumn(key).alignment = { horizontal: 'right' }
  }
  return wb
}

/** Build the workbook and trigger a download. Returns once the file has been handed to the browser. */
export async function exportLedgerXlsx(data: LedgerXlsxData): Promise<void> {
  const wb = await buildLedgerWorkbook(data)
  const buf = await wb.xlsx.writeBuffer()
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  downloadBlob(`konclave-${data.vaultName.replace(/[^\w-]+/g, '-').toLowerCase() || 'ledger'}.xlsx`, blob)
}
