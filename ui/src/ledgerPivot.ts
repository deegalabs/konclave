// The book by beneficiary (#778): paid so far and still to pay, per person, over the rows in view.
//
// The community's spreadsheet reads a distribution as a pivot: one line per person, what left and
// what is committed. This builds that from the book the screen already holds, in whole zatoshi
// (#303), and checks itself against the book's totals: a payroll whose lines could not be read is
// a named difference, never a silent zero.
import type { Beneficiary, PayrollLine, Proposal } from './api'
import { sumZat } from './format'

/** One row of the book: a payment, or one line of a payroll. A payroll whose lines were not read
 *  (none in `linesById`, or an empty list) is one row at its own value, marked `unread`. */
export type BookItem = {
  proposal: Proposal
  address: string
  /** The payroll line's label, '' for a plain payment or an unread payroll. */
  label: string
  /** The line's own memo for a payroll line, the proposal's otherwise. */
  memo: string
  value_zat: number
  unread: boolean
}

/** The book itemized: the one rule the export and the book by beneficiary both read. */
export function itemizeBook(proposals: readonly Proposal[], linesById: Readonly<Record<string, PayrollLine[]>>): BookItem[] {
  const items: BookItem[] = []
  for (const p of proposals) {
    if (p.kind === 'payroll') {
      const lines = linesById[p.id]
      if (!lines || lines.length === 0) {
        items.push({ proposal: p, address: '', label: '', memo: p.memo ?? '', value_zat: p.value_zat, unread: true })
        continue
      }
      for (const l of lines) items.push({ proposal: p, address: l.address, label: l.label ?? '', memo: l.memo ?? '', value_zat: l.value_zat, unread: false })
    } else {
      items.push({ proposal: p, address: p.to_address ?? '', label: '', memo: p.memo ?? '', value_zat: p.value_zat, unread: false })
    }
  }
  return items
}

export type PivotEntry = {
  address: string
  /** The payroll line's label, '' for a plain payment. */
  label: string
  settled: boolean
  open: boolean
  value_zat: number
}

export type PayeeRow = {
  address: string
  /** The registry's name for this address (the treasurer's deliberate book of names), else the
   *  first label seen on a line (one day's sheet), else ''. */
  name: string
  paidZat: number
  dueZat: number
  /** Entries behind the row (payments and payroll lines). */
  lines: number
}

export type PivotTotals = { paidZat: number; dueZat: number }

/** One entry per payment and per payroll line, with the proposal's state. A payroll whose lines
 *  could not be read is listed in `missing` instead of being counted as nothing; a closed proposal
 *  (neither settled nor open) counts in neither total, so it is neither an entry nor missing. */
export function pivotEntries(
  proposals: readonly Proposal[],
  linesById: Readonly<Record<string, PayrollLine[]>>,
  settled: (state: string) => boolean,
  open: (p: Proposal) => boolean,
): { entries: PivotEntry[]; missing: string[] } {
  const entries: PivotEntry[] = []
  const missing: string[] = []
  const live = proposals.filter((p) => settled(p.state) || open(p))
  for (const it of itemizeBook(live, linesById)) {
    // No lines at all is "not read", whichever way it came: the export counts such a payroll at its
    // own value, and a silent zero here would make the two disagree without a word.
    if (it.unread) { missing.push(it.proposal.id); continue }
    entries.push({ address: it.address, label: it.label, settled: settled(it.proposal.state), open: open(it.proposal), value_zat: it.value_zat })
  }
  return { entries, missing }
}

/** Group by address: paid (settled) and due (open) summed apart, in whole zatoshi; closed entries left out. */
export function pivotByPayee(entries: readonly PivotEntry[], registry: readonly Beneficiary[] = []): { rows: PayeeRow[]; totals: PivotTotals } {
  const live = entries.filter((e) => e.settled || e.open)
  const byAddr = new Map<string, { name: string; paid: PivotEntry[]; due: PivotEntry[] }>()
  for (const e of live) {
    const address = e.address.trim()
    let g = byAddr.get(address)
    if (!g) { g = { name: '', paid: [], due: [] }; byAddr.set(address, g) }
    if (!g.name && e.label.trim()) g.name = e.label.trim()
    if (e.settled) g.paid.push(e)
    else g.due.push(e)
  }
  const rows: PayeeRow[] = [...byAddr].map(([address, g]) => ({
    address,
    name: registry.find((b) => b.address.trim() === address)?.name || g.name,
    paidZat: sumZat(g.paid),
    dueZat: sumZat(g.due),
    lines: g.paid.length + g.due.length,
  }))
  rows.sort((a, b) => (b.paidZat + b.dueZat) - (a.paidZat + a.dueZat))
  const totals = { paidZat: sumZat(live.filter((e) => e.settled)), dueZat: sumZat(live.filter((e) => !e.settled)) }
  return { rows, totals }
}

/** The pivot against the book: equal, or the two columns' differences added, in zatoshi. */
export function pivotCheck(totals: PivotTotals, bookPaidZat: number, bookDueZat: number): { ok: boolean; diffZat: number } {
  const diffZat = Math.abs(bookPaidZat - totals.paidZat) + Math.abs(bookDueZat - totals.dueZat)
  return { ok: diffZat === 0, diffZat }
}
