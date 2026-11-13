import { shortAddr, type PayrollLine } from './api'
import { useT } from './i18n'
import type { Unusual } from './unusual'
import type { UnusualState } from './useUnusual'

// "Out of the ordinary" on the proposal, while a member can still act on it (vote or sign).
//
// A READING AID, NOT A DEFENCE (unusual.ts): the history it compares with is the coordinator's, so
// the copy says so, and says first that what the device reads from the transaction is what counts.
// It names what to look at and never an amount: the amounts are on the screen already, behind the
// veil. Reading and a failed read are each said in a line, so the note's absence only ever means
// the comparison ran and found nothing.

/** Lines shown before "and N more". */
export const SHOWN = 5

function sentence(f: Unusual, who: string, t: ReturnType<typeof useT>): string {
  switch (f.kind) {
    case 'first-payment': return t('unusual.first', { who })
    case 'above-usual': return t('unusual.above', { who })
    case 'payroll-added': return t('unusual.added', { who })
    case 'payroll-removed': return t('unusual.removed', { who })
    case 'payroll-amount': return t('unusual.amount', { who })
  }
}

/** One finding per address, the first the rule lists (it lists first payments first, so a newcomer
 *  to a payroll is "no earlier payment", not that and "not on the previous payroll" too). */
function oncePerAddress(findings: readonly Unusual[]): Unusual[] {
  const seen = new Set<string>()
  return findings.filter((f) => !seen.has(f.address) && (seen.add(f.address), true))
}

function Body({ state, lines }: { state: UnusualState; lines: readonly PayrollLine[] }) {
  const t = useT()
  if (state.status === 'reading') return <p className="hint">{t('unusual.reading')}</p>
  if (state.status === 'failed') return <p className="hint">{t('unusual.failed')}</p>
  const { reading, names } = state
  if (reading.findings.length === 0 && !reading.incomplete) return null
  const findings = oncePerAddress(reading.findings)
  const who = (address: string) => {
    const label = names.get(address)
    return label ? `${label} (${shortAddr(address)})` : shortAddr(address)
  }
  // A vault's first payroll: every line is new, and one sentence says it better than a list of all.
  const addresses = new Set(lines.map((l) => l.address.trim()).filter(Boolean))
  const allNew = findings.length > 1 && findings.length === addresses.size && findings.every((f) => f.kind === 'first-payment')
  const more = findings.length - SHOWN
  return (
    <section className="p-unusual" aria-labelledby="unusual-title">
      <h2 className="klab" id="unusual-title">{t('unusual.title')}</h2>
      {allNew
        ? <p className="p-unusual-one">{t('unusual.allNew', { n: String(findings.length) })}</p>
        : findings.length > 0 && (
          <ul className="p-unusual-list">
            {findings.slice(0, SHOWN).map((f) => <li key={f.address}>{sentence(f, who(f.address), t)}</li>)}
            {more > 0 && <li>{t('unusual.more', { n: String(more) })}</li>}
          </ul>
        )}
      {reading.incomplete && <p className="hint mt-sm">{t('unusual.incomplete')}</p>}
      <p className="p-unusual-aid mt-sm">{t('unusual.aid')}</p>
    </section>
  )
}

/** The live region is mounted with the proposal and filled when the reading lands, so a screen
 *  reader announces the note even to someone who has already moved past where it appears. */
export function UnusualNote({ state, lines }: { state: UnusualState | null; lines: readonly PayrollLine[] }) {
  return (
    <div className="p-unusual-live mt" aria-live="polite">
      {state && <Body state={state} lines={lines} />}
    </div>
  )
}
