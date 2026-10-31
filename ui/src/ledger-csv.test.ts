import { describe, expect, it } from 'vitest'
import { ledgerCsvText } from './ledgerCsv'
import type { LedgerXlsxData, LedgerXlsxItem } from './ledgerXlsx'

// The browser CSV (#301, #304): the same rows as the XLSX, a UTF-8 BOM so Excel reads accents, the
// delimiter and decimal mark of the member's locale, and a cell that starts with = + - or @
// neutralised, so a memo or a payee name cannot become a formula in a spreadsheet.

const labels: LedgerXlsxData['labels'] = {
  summary: 'Summary', movements: 'Movements', vault: 'Vault', period: 'Period', filter: 'Filter', generated: 'Generated',
  entries: 'Entries', settledOut: 'Settled out', open: 'Open', colDate: 'Date', colDocument: 'Document', colKind: 'Kind',
  colBeneficiary: 'Beneficiary', colAddress: 'Address', colMemo: 'Memo', colProposedBy: 'Proposed by', colApprovedBy: 'Approved by',
  colState: 'State', colSettled: 'Settled', colOpen: 'Open', colValue: 'Value', colTxid: 'Transaction (txid)', total: 'TOTAL', yes: 'yes', no: 'no',
}
const item = (over: Partial<LedgerXlsxItem> = {}): LedgerXlsxItem => ({
  dateISO: '2026-10-01', document: 'Rent', kind: 'Payment', beneficiary: '', address: 'u1rent', memo: '',
  proposer: 'Alice', approvers: 'Alice, Bob', state: 'confirmed', settled: true, open: false, zec: 1.5, txid: '', ...over,
})
const data = (items: LedgerXlsxItem[]): LedgerXlsxData => ({ vaultName: 'Caixa', period: '2026-10', filter: '', generatedAt: new Date(0), items, labels })

describe('the browser CSV of the ledger', () => {
  it('starts with a BOM, names the columns like the XLSX, and writes one row per item', () => {
    const csv = ledgerCsvText(data([item()]), 'en')
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const [head, row] = csv.slice(1).split('\r\n')
    expect(head).toBe('Date,Document,Kind,Beneficiary,Address,Memo,Proposed by,Approved by,State,Settled,Open,Value,Transaction (txid)')
    expect(row).toBe('2026-10-01,Rent,Payment,,u1rent,,Alice,"Alice, Bob",confirmed,yes,no,1.50000000,')
  })

  it('uses the semicolon and the decimal comma for pt-BR, so Excel there reads the amounts as numbers', () => {
    const row = ledgerCsvText(data([item({ zec: 0.00001234 })]), 'pt-BR').slice(1).split('\r\n')[1]
    expect(row).toBe('2026-10-01;Rent;Payment;;u1rent;;Alice;Alice, Bob;confirmed;yes;no;0,00001234;')
  })

  it('neutralises a cell that starts with = + - or @, and quotes commas, quotes and line breaks', () => {
    const csv = ledgerCsvText(data([
      item({ document: '=SUM(A1)', memo: '+1', beneficiary: '-x', address: '@a' }),
      item({ memo: 'say "hi", twice\nplease' }),
    ]), 'en')
    const rows = csv.slice(1).split('\r\n')
    expect(rows[1]).toBe("2026-10-01,'=SUM(A1),Payment,'-x,'@a,'+1,Alice,\"Alice, Bob\",confirmed,yes,no,1.50000000,")
    expect(rows[2]).toContain('"say ""hi"", twice\nplease"')
  })
})
