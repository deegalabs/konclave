// The Ledger's payroll lines (#949), from the one reader of the book with its lines.
//
// On the web the vault's proposals already carry every payroll's lines, so the lines of any number of
// payrolls come from ONE read (`getBookWithLines`). The detail reader re-reads the whole proposal list
// on each call there, and the Ledger used to call it once per payroll. The local bridge serves lines by
// id only, so there each payroll is read on its own, and with no cap: `getBookWithLines` stops at the
// newest BRIDGE_PAYROLLS_READ settled payrolls, which the Ledger cannot afford to lose.
import { IS_NET, getBookWithLines, getProposalDetail, type PayrollLine } from './api'

/** The lines of each payroll in `ids` the source answered for, keyed by id: `[]` for one that answered
 *  with no lines, absent for one it did not answer for (an unreadable book, a failed detail read, an id
 *  it does not know), exactly as one detail read per payroll answered. */
export async function readPayrollLines(ids: string[]): Promise<Record<string, PayrollLine[]>> {
  const out: Record<string, PayrollLine[]> = {}
  if (ids.length === 0) return out
  if (IS_NET) {
    const book = await getBookWithLines()
    if (!book) return out
    const known = new Set(book.history.map((p) => p.id))
    for (const id of ids) if (known.has(id)) out[id] = book.linesById[id] ?? []
    return out
  }
  for (const id of ids) {
    const d = await getProposalDetail(id)
    if (d) out[id] = d.lines ?? []
  }
  return out
}
