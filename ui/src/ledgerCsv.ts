// The ledger's CSV, built in the browser from the same rows as the XLSX (#301): it honours the
// screen's period and filters, works on every path, and never depends on a server endpoint.
//
// Interop (#304): a UTF-8 BOM so Excel on Windows reads accents; the delimiter and the decimal mark
// of the member's locale (";" and "," for pt-BR, "," and "." for en), so amounts parse as numbers
// there; CRLF line ends; every amount with all eight places.
//
// Safety (#301, #304): a cell that starts with "=", "+", "-" or "@" (or a tab or carriage return)
// is prefixed with an apostrophe, so a memo or a payee name typed by anyone cannot become a formula
// when the file opens in a spreadsheet. Only text cells are candidates: the amount column is ours.

import { downloadBlob } from './download'
import type { LedgerXlsxData, LedgerXlsxItem } from './ledgerXlsx'

export type CsvLocale = 'pt-BR' | 'en'

const FORMULA_START = /^[=+\-@\t\r]/

/** One text cell: neutralised if it could be a formula, then quoted when the delimiter demands it. */
export function csvCell(raw: string, delimiter: string): string {
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw
  return /["\n\r]/.test(safe) || safe.includes(delimiter) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function amount(zec: number, decimal: string): string {
  const s = zec.toFixed(8)
  return decimal === '.' ? s : s.replace('.', decimal)
}

/** The whole file as text, BOM included. Pure, so a test can read it line by line. */
export function ledgerCsvText(data: LedgerXlsxData, locale: CsvLocale): string {
  const delimiter = locale === 'pt-BR' ? ';' : ','
  const decimal = locale === 'pt-BR' ? ',' : '.'
  const L = data.labels
  const head = [L.colDate, L.colDocument, L.colKind, L.colBeneficiary, L.colAddress, L.colMemo, L.colProposedBy, L.colApprovedBy, L.colState, L.colSettled, L.colOpen, L.colValue, L.colTxid]
  const row = (it: LedgerXlsxItem) => [
    it.dateISO, it.document, it.kind, it.beneficiary, it.address, it.memo, it.proposer, it.approvers, it.state,
    it.settled ? L.yes : L.no, it.open ? L.yes : L.no,
  ].map((c) => csvCell(c, delimiter)).concat([amount(it.zec, decimal), csvCell(it.txid, delimiter)])
  const lines = [head.map((c) => csvCell(c, delimiter)), ...data.items.map(row)]
  return '﻿' + lines.map((cells) => cells.join(delimiter)).join('\r\n') + '\r\n'
}

/** Build the file and hand it to the browser. */
export async function exportLedgerCsv(data: LedgerXlsxData, locale: CsvLocale): Promise<void> {
  const text = ledgerCsvText(data, locale)
  const name = `konclave-${data.vaultName.replace(/[^\w-]+/g, '-').toLowerCase() || 'ledger'}.csv`
  downloadBlob(name, new Blob([text], { type: 'text/csv;charset=utf-8' }))
}
