// The book by beneficiary (#778): paid so far and still to pay, per person, over the rows in view.
//
// The community's spreadsheet reads a distribution as a pivot: one line per person, what left and
// what is committed. This builds that from the book the screen already holds, in whole zatoshi
// (#303), and checks itself against the book's totals: a payroll whose lines could not be read is
// a named difference, never a silent zero.
import type { Beneficiary, PayrollLine, Proposal } from './api'

export type PivotEntry = {
  address: string
  /** The payroll line's label, '' for a plain payment. */
  label: string
  settled: boolean
  open: boolean
  zat: number
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
 *  are not in `linesById` is listed in `missing` instead of being counted as nothing. */
export function pivotEntries(
  proposals: readonly Proposal[],
  linesById: Readonly<Record<string, PayrollLine[]>>,
  settled: (state: string) => boolean,
  open: (p: Proposal) => boolean,
): { entries: PivotEntry[]; missing: string[] } {
  const entries: PivotEntry[] = []
  const missing: string[] = []
  for (const p of proposals) {
    const s = settled(p.state)
    const o = open(p)
    if (p.kind === 'payroll') {
      const lines = linesById[p.id]
      // No lines at all is "not read", whichever way it came: the export counts such a payroll at its
      // own value, and a silent zero here would make the two disagree without a word.
      if (!lines || lines.length === 0) { missing.push(p.id); continue }
      for (const l of lines) entries.push({ address: l.address, label: l.label ?? '', settled: s, open: o, zat: l.value_zat })
    } else {
      entries.push({ address: p.to_address ?? '', label: '', settled: s, open: o, zat: p.value_zat })
    }
  }
  return { entries, missing }
}

/** Group by address: paid (settled) and due (open) summed apart; closed entries left out. */
export function pivotByPayee(entries: readonly PivotEntry[], registry: readonly Beneficiary[] = []): { rows: PayeeRow[]; totals: PivotTotals } {
  const byAddr = new Map<string, PayeeRow>()
  for (const e of entries) {
    if (!e.settled && !e.open) continue
    const address = e.address.trim()
    let row = byAddr.get(address)
    if (!row) {
      row = { address, name: '', paidZat: 0, dueZat: 0, lines: 0 }
      byAddr.set(address, row)
    }
    if (!row.name && e.label.trim()) row.name = e.label.trim()
    if (e.settled) row.paidZat += e.zat
    else row.dueZat += e.zat
    row.lines += 1
  }
  for (const row of byAddr.values()) {
    const reg = registry.find((b) => b.address.trim() === row.address)?.name
    if (reg) row.name = reg
  }
  const rows = [...byAddr.values()].sort((a, b) => (b.paidZat + b.dueZat) - (a.paidZat + a.dueZat))
  const totals = rows.reduce((t, r) => ({ paidZat: t.paidZat + r.paidZat, dueZat: t.dueZat + r.dueZat }), { paidZat: 0, dueZat: 0 })
  return { rows, totals }
}

/** The pivot against the book: equal, or the two columns' differences added, in zatoshi. */
export function pivotCheck(totals: PivotTotals, bookPaidZat: number, bookDueZat: number): { ok: boolean; diffZat: number } {
  const diffZat = Math.abs(bookPaidZat - totals.paidZat) + Math.abs(bookDueZat - totals.dueZat)
  return { ok: diffZat === 0, diffZat }
}
