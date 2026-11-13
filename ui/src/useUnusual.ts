import { useEffect, useState } from 'react'
import { getBookWithLines, type PayrollLine, type Proposal } from './api'
import { unusualFor, type UnusualReading } from './unusual'

// The reading behind "Worth a second look" (UnusualNote.tsx): the vault's book with its payrolls'
// lines, read once per proposal while a member can still vote or sign it.

export type UnusualState =
  | { status: 'reading' }
  /** The book could not be read, so nothing was compared. Said, never shown as "nothing found". */
  | { status: 'failed' }
  /** `names`: a label per address, from this payroll and then the earlier ones, so a person who left
   *  the payroll is named as the previous payroll named them. */
  | { status: 'read'; reading: UnusualReading; names: ReadonlyMap<string, string> }

function namesFrom(lines: readonly PayrollLine[], earlier: Readonly<Record<string, PayrollLine[]>>): Map<string, string> {
  const names = new Map<string, string>()
  for (const l of [...lines, ...Object.values(earlier).flat()]) {
    const address = l.address.trim()
    const label = (l.label ?? '').trim()
    if (address && label && !names.has(address)) names.set(address, label)
  }
  return names
}

/** null while the proposal is not one a member can act on (sent, closed, or not loaded). */
export function useUnusual(p: Proposal | null, lines: readonly PayrollLine[]): UnusualState | null {
  const [state, setState] = useState<UnusualState | null>(null)
  // Only while a member can still act on it: once it is sent or closed there is no decision to aid.
  const key = p && (p.state === 'awaiting' || p.state === 'ready') ? p.id : null
  useEffect(() => {
    if (!key || !p) { setState(null); return }
    let on = true
    setState({ status: 'reading' })
    void (async () => {
      const book = await getBookWithLines()
      if (!on) return
      if (!book) { setState({ status: 'failed' }); return }
      const reading = unusualFor(p, p.kind === 'payroll' ? lines : null, book.history, book.linesById)
      setState({ status: 'read', reading, names: namesFrom(lines, book.linesById) })
    })()
    return () => { on = false }
    // Once per proposal: the poll that refreshes `p` (and hands new arrays of the same lines) must
    // neither re-read the book nor make the note disappear and come back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}
