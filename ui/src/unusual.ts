// "Out of the ordinary" (fora do comum): what a voter may want to look at twice before approving.
//
// A READING AID, NOT A DEFENCE. It compares the proposal with the vault's history as the
// coordinator serves it, and the coordinator writes that history: a coordinator that lies about the
// past can make anything look ordinary, and nothing here can tell. It is also a product rule, not
// a protocol one (CLAUDE.md §6.14): a payment it does not flag is not thereby safe, and one it flags
// is not thereby wrong. What the device itself reads from the transaction (what the signature
// covers) stays the thing that decides, and the copy says so when this reaches a screen.
//
// One rule, three findings, over SETTLED payments only (money that left the vault), by address,
// read through the ledger's own `pivotEntries` so a payroll line counts as a payment to its address:
//   first-payment   no earlier settled payment went to this address
//   above-usual     more than twice the median of the earlier settled payments to this address,
//                   once there are at least three of them to speak of a usual amount
//   payroll-*       against the latest earlier settled payroll: who was added, who was removed,
//                   whose amount changed (lines to one address added up first)
//
// "Earlier" means created no later than the proposal under review (the proposal itself is left
// out by id); an undated one counts as earlier. A payment or a payroll line under review with no
// address is not compared with anything, and the answer says `incomplete`. When the book cannot be
// read whole (an earlier payroll whose lines were not read, or the payroll under review with no
// lines), the answer says `incomplete` rather than presenting a partial comparison as the whole one.
import type { PayrollLine, Proposal } from './api'
import { SETTLED } from './ledger-state'
import { pivotEntries } from './ledgerPivot'
import { createdAt } from './period'

export type Unusual =
  | { kind: 'first-payment'; address: string }
  | { kind: 'above-usual'; address: string; valueZat: number; medianZat: number }
  | { kind: 'payroll-added'; address: string }
  | { kind: 'payroll-removed'; address: string }
  | { kind: 'payroll-amount'; address: string; beforeZat: number; afterZat: number }

export type UnusualReading = {
  findings: Unusual[]
  /** Part of the book could not be read, so the findings are what the readable part shows. */
  incomplete: boolean
  /** The earlier payroll a payroll was compared with, when one was. */
  comparedTo: string | null
}

const MIN_HISTORY = 3
const NEVER_OPEN = () => false

/** Per address, trimmed, summed. */
function byAddress(rows: ReadonlyArray<{ address: string; value_zat: number }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    const a = r.address.trim()
    if (a) m.set(a, (m.get(a) ?? 0) + r.value_zat)
  }
  return m
}

/** Twice the median, which is exact in whole zatoshi for an even count as for an odd one. */
function twiceMedian(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? 2 * s[mid]! : s[mid - 1]! + s[mid]!
}

export function unusualFor(
  target: Proposal,
  targetLines: readonly PayrollLine[] | null,
  history: readonly Proposal[],
  linesById: Readonly<Record<string, PayrollLine[]>>,
): UnusualReading {
  // An undated proposal (on either side) is compared with everything, rather than with nothing.
  const at = createdAt(target)
  const earlier = history.filter((p) => {
    if (p.id === target.id || !SETTLED(p.state)) return false
    const t = createdAt(p)
    return t === null || at === null || t <= at
  })
  let incomplete = pivotEntries(earlier, linesById, SETTLED, NEVER_OPEN).missing.length > 0

  // One amount per earlier proposal and address, the same unit as `pays` below: a payroll that
  // pays one address in several lines is one payment to it, before and now.
  const paid = new Map<string, number[]>()
  for (const p of earlier) {
    for (const [a, zat] of byAddress(pivotEntries([p], linesById, SETTLED, NEVER_OPEN).entries)) {
      paid.set(a, [...(paid.get(a) ?? []), zat])
    }
  }

  // What the proposal under review pays, per address.
  let pays: Map<string, number>
  if (target.kind === 'payroll') {
    if (!targetLines || targetLines.length === 0) return { findings: [], incomplete: true, comparedTo: null }
    pays = byAddress(targetLines)
    // A line with no address was not compared with anything, so the reading is not whole.
    if (targetLines.some((l) => !l.address.trim())) incomplete = true
  } else {
    pays = byAddress([{ address: target.to_address ?? '', value_zat: target.value_zat }])
    if (pays.size === 0) incomplete = true
  }

  const first: Unusual[] = []
  const above: Unusual[] = []
  for (const [address, valueZat] of pays) {
    const before = paid.get(address)
    if (!before) { first.push({ kind: 'first-payment', address }); continue }
    if (before.length < MIN_HISTORY) continue
    const twice = twiceMedian(before)
    if (valueZat > twice) above.push({ kind: 'above-usual', address, valueZat, medianZat: Math.floor(twice / 2) })
  }

  const changes: Unusual[] = []
  let comparedTo: string | null = null
  if (target.kind === 'payroll') {
    const prev = earlier
      .filter((p) => p.kind === 'payroll')
      .sort((a, b) => (createdAt(b) ?? -Infinity) - (createdAt(a) ?? -Infinity))[0]
    if (prev) {
      const was = pivotEntries([prev], linesById, SETTLED, NEVER_OPEN)
      if (was.missing.length > 0) {
        incomplete = true
      } else {
        comparedTo = prev.id
        const before = byAddress(was.entries)
        const added: Unusual[] = []
        const removed: Unusual[] = []
        const amount: Unusual[] = []
        for (const [address, afterZat] of pays) {
          const beforeZat = before.get(address)
          if (beforeZat === undefined) added.push({ kind: 'payroll-added', address })
          else if (beforeZat !== afterZat) amount.push({ kind: 'payroll-amount', address, beforeZat, afterZat })
        }
        for (const address of before.keys()) if (!pays.has(address)) removed.push({ kind: 'payroll-removed', address })
        changes.push(...added, ...removed, ...amount)
      }
    }
  }

  return { findings: [...first, ...above, ...changes], incomplete, comparedTo }
}
