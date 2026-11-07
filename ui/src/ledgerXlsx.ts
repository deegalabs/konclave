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
import type { Beneficiary } from './api'
import { explorerTxUrl, sumZat } from './format'
import { downloadBlob } from './download'
import { pivotByPayee } from './ledgerPivot'

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
  value_zat: number // outflow for this row, in whole zatoshi (#303); written as ZEC with 8 places
  txid: string // '' until the proposal was sent; a payroll's rows share one (#302)
  /** A payroll whose lines could not be read, carried as one row at its own value. */
  unread?: boolean
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
  /** The registry (Pessoas): its name for an address wins over the line's label, as on the screen. */
  registry?: readonly Beneficiary[]
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
    unreadPayrolls: string
    balanceUnread: string
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
  // Each formula carries the value it computes (#812): a viewer that does not recalculate (Excel's
  // Protected View, a phone previewer) shows that value, and without it the totals were blank. The
  // export already knows the rows, so it sums them itself, in whole zatoshi: adding ZEC as floating
  // point makes 0.1 + 0.2 a figure no ledger holds.
  const zatWhere = (keep: (it: LedgerXlsxItem) => boolean) => sumZat(data.items.filter(keep))
  const settledZat = zatWhere((it) => it.settled)
  const openZat = zatWhere((it) => it.open)
  // A criterion matches its text and nothing else: quotes doubled, the wildcards * ? ~ escaped, and
  // a leading = < > read as text, not as a comparison.
  const crit = (v: string) => `"${/^[=<>]/.test(v) ? '=' : ''}${v.replace(/[~*?]/g, '~$&').replace(/"/g, '""')}"`
  const YES = crit(L.yes)
  const sumIf = (col: string, zat: number) => (n === 0 ? 0 : { formula: `SUMIF(${MV}!${span(col)},${YES},${MV}!${span(valueCol)})`, result: zat / 1e8 })

  // ---- Summary sheet (first tab) with live formulas referencing Movements ----
  const sm = wb.addWorksheet(L.summary)
  sm.columns = [{ key: 'k', width: 36 }, { key: 'v', width: 34 }]
  const put = (k: string, v: string | number | { formula: string; result: number }, opts?: { money?: boolean; bold?: boolean }) => {
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
  const settledRow = put(L.settledOut, sumIf(settledCol, settledZat), { money: true, bold: true })
  const openRow = put(L.open, sumIf(openCol, openZat), { money: true, bold: true })
  // Outflows by kind and entries by state: the accountant's own reading of a period, as live
  // formulas over Movements like the two totals above.
  sm.addRow({})
  // Settled outflows only: a refused or expired row of either kind never left the vault.
  const outOf = (kind: string) =>
    n === 0 ? 0 : { formula: `SUMIFS(${MV}!${span(valueCol)},${MV}!${span(kindCol)},${crit(kind)},${MV}!${span(settledCol)},${YES})`, result: zatWhere((it) => it.kind === kind && it.settled) / 1e8 }
  put(L.outPayments, outOf(L.kindPayment), { money: true })
  put(L.outPayrolls, outOf(L.kindPayroll), { money: true })
  // Rows, not proposals: a payroll counts one per line, as the Entries row does.
  if (n > 0) {
    sm.addRow({})
    const byStateRow = sm.addRow({ k: L.byState })
    byStateRow.getCell('k').font = { bold: true }
    for (const st of [...new Set(data.items.map((it) => it.state))]) {
      put(st.charAt(0).toUpperCase() + st.slice(1), { formula: `COUNTIF(${MV}!${span(stateCol)},${crit(st)})`, result: data.items.filter((it) => it.state === st).length })
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
    const z = (x: number) => Math.round(x * 1e8)
    const availableZat = z(data.balance.totalZec) - z(data.balance.reservedZec) - z(data.balance.confirmingZec)
    put(L.available, { formula: `B${pos.number}-B${com.number}-B${conf.number}`, result: availableZat / 1e8 }, { money: true, bold: true })
    if (data.balance.overCommitted) put(L.overCommitted, '', { bold: true })
  } else {
    // Said, not dropped: a Summary with no position would read as a vault with nothing in it.
    sm.addRow({})
    put(L.balanceUnread, '')
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
      zec: it.value_zat / 1e8,
      txid: it.txid,
    })
    if (it.txid) row.getCell('txid').value = { text: it.txid, hyperlink: explorerTxUrl(it.txid) }
  }
  // The TOTAL row agrees with the summary: what moved plus what can still move. A plain SUM of the
  // column added the refused and expired rows, whose money never left and which enter neither
  // summary total, so the sheet's own total disagreed with both of them.
  const sumIfHere = (col: string) => `SUMIF(${span(col)},${YES},${span(valueCol)})`
  const totalRow = mv.addRow({ document: L.total, zec: n === 0 ? 0 : { formula: `${sumIfHere(settledCol)}+${sumIfHere(openCol)}`, result: (settledZat + openZat) / 1e8 } })
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
  // The rows are the book by beneficiary, the screen's own rule (pivotByPayee): settled and open
  // in whole zatoshi, closed entries left out, the registry's name first and else the first label,
  // sorted by the integer sum. A payroll whose lines could not be read is not a beneficiary: it is
  // in the Summary at its own value and not here, so the difference row names it, as the screen does.
  const live = data.items.filter((it) => !it.unread)
  const pivot = pivotByPayee(
    live.map((it) => ({ address: it.address, label: it.beneficiary, settled: it.settled, open: it.open, value_zat: it.value_zat })),
    data.registry ?? [],
  )
  const unreadCount = data.items.filter((it) => it.unread && (it.settled || it.open)).length
  const SM = sheet(L.summary)
  for (const r of pivot.rows) {
    // On Movements an unread payroll has no address either; only payments can be this row, so its
    // formulas ask for the payment kind as well.
    const where = `${MV}!${span(addressCol)},${crit(r.address)}` + (r.address === '' ? `,${MV}!${span(kindCol)},${crit(L.kindPayment)}` : '')
    const countIn = (col: string) => `COUNTIFS(${where},${MV}!${span(col)},${YES})`
    bp.addRow({
      // No address: a payment with none recorded. The row is named, so nobody reads a nameless row holding ZEC.
      name: r.address === '' ? L.noAddress : r.name,
      address: r.address,
      settled: { formula: `SUMIFS(${MV}!${span(valueCol)},${where},${MV}!${span(settledCol)},${YES})`, result: r.paidZat / 1e8 },
      open: { formula: `SUMIFS(${MV}!${span(valueCol)},${where},${MV}!${span(openCol)},${YES})`, result: r.dueZat / 1e8 },
      count: { formula: `${countIn(settledCol)}+${countIn(openCol)}`, result: r.lines },
    })
  }
  const payees = pivot.rows
  const pFirst = 2
  const pLast = pFirst + payees.length - 1
  const pSpan = (col: string) => `${col}${pFirst}:${col}${pLast}`
  const pSettledZat = pivot.totals.paidZat
  const pOpenZat = pivot.totals.dueZat
  const pTotal = bp.addRow({
    name: L.total,
    settled: payees.length === 0 ? 0 : { formula: `SUM(${pSpan('C')})`, result: pSettledZat / 1e8 },
    open: payees.length === 0 ? 0 : { formula: `SUM(${pSpan('D')})`, result: pOpenZat / 1e8 },
    count: payees.length === 0 ? 0 : { formula: `SUM(${pSpan('E')})`, result: payees.reduce((acc, r) => acc + r.lines, 0) },
  })
  pTotal.font = { bold: true }
  // Zero when the sheet agrees with the Summary; any other number is a difference to look into.
  const pDiff = bp.addRow({
    name: L.difference,
    // Over the Summary and the total row, never over itself, so it is a formula even with no row
    // above it: a book whose only payroll is unread still shows its difference.
    settled: n === 0 ? 0 : { formula: `${SM}!B${settledRow.number}-C${pTotal.number}`, result: (settledZat - pSettledZat) / 1e8 },
    open: n === 0 ? 0 : { formula: `${SM}!B${openRow.number}-D${pTotal.number}`, result: (openZat - pOpenZat) / 1e8 },
  })
  pDiff.font = { italic: true }
  if (unreadCount > 0) bp.addRow({ name: L.unreadPayrolls, settled: unreadCount }).getCell('settled').numFmt = '0'
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
