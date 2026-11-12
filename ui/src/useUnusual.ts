import { useEffect, useState } from 'react'
import { getLedger, getProposalDetail, type PayrollLine, type Proposal } from './api'
import { SETTLED } from './ledger-state'
import { unusualFor, type UnusualReading } from './unusual'

// The reading behind "Worth a second look" (UnusualNote.tsx): the vault's book and the payroll lines
// unusual.ts needs, read once per proposal while a member can still vote or sign it.

/** Earlier settled payrolls whose lines are read for the comparison, newest first. Past this the
 *  reading says it is incomplete rather than issuing a request per payroll the vault ever made. */
export const PAYROLLS_READ = 12

/** The history and the lines it needs, read once per proposal; null until read or when unreadable. */
export function useUnusual(p: Proposal | null, lines: readonly PayrollLine[]): UnusualReading | null {
  const [reading, setReading] = useState<UnusualReading | null>(null)
  // Only while a member can still act on it: once it is sent or closed there is no decision to aid.
  const key = p && (p.state === 'awaiting' || p.state === 'ready') ? p.id : null
  useEffect(() => {
    setReading(null)
    if (!key || !p) return
    let on = true
    void (async () => {
      const history = await getLedger()
      if (!on || !history) return
      const payrolls = history
        .filter((h) => h.id !== p.id && h.kind === 'payroll' && SETTLED(h.state))
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
        .slice(0, PAYROLLS_READ)
      const linesById: Record<string, PayrollLine[]> = {}
      for (const r of payrolls) {
        const d = await getProposalDetail(r.id)
        if (!on) return
        if (d?.lines && d.lines.length > 0) linesById[r.id] = d.lines
      }
      setReading(unusualFor(p, p.kind === 'payroll' ? lines : null, history, linesById))
    })()
    return () => { on = false }
    // Read once per proposal: a poll that refreshes `p` must not re-read the whole history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, lines.length])
  return reading
}
