import { shortAddr, type PayrollLine } from './api'
import { useT } from './i18n'
import type { Unusual, UnusualReading } from './unusual'

// "Out of the ordinary" on the proposal, while a member can still act on it (vote or sign).
//
// A READING AID, NOT A DEFENCE (unusual.ts): the history it compares with is the coordinator's, so
// the copy says so, and says that what the device reads from the transaction is what counts. It
// names what to look at and never an amount: the amounts are on the screen already, behind the veil.

function line(f: Unusual, who: string, t: ReturnType<typeof useT>): string {
  switch (f.kind) {
    case 'first-payment': return t('unusual.first', { who })
    case 'above-usual': return t('unusual.above', { who })
    case 'payroll-added': return t('unusual.added', { who })
    case 'payroll-removed': return t('unusual.removed', { who })
    case 'payroll-amount': return t('unusual.amount', { who })
  }
}

export function UnusualNote({ reading, lines }: { reading: UnusualReading | null; lines: readonly PayrollLine[] }) {
  const t = useT()
  if (!reading || (reading.findings.length === 0 && !reading.incomplete)) return null
  const labelOf = new Map(lines.map((l) => [l.address.trim(), (l.label ?? '').trim()]))
  const who = (address: string) => {
    const label = labelOf.get(address)
    return label ? `${label} (${shortAddr(address)})` : shortAddr(address)
  }
  return (
    <section className="p-unusual mt" aria-labelledby="unusual-title">
      <h2 className="klab" id="unusual-title">{t('unusual.title')}</h2>
      {reading.findings.length > 0 && (
        <ul className="p-unusual-list">
          {reading.findings.map((f) => <li key={f.kind + f.address}>{line(f, who(f.address), t)}</li>)}
        </ul>
      )}
      {reading.incomplete && <p className="hint mt-sm">{t('unusual.incomplete')}</p>}
      <p className="hint mt-sm">{t('unusual.aid')}</p>
    </section>
  )
}
