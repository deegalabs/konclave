// Test helper (#575): give a fixture the `stances` an answer carries, the way the LOCAL BRIDGE
// answers (rows only for who voted, no seat, every one counted). Fixtures written before stances
// listed names; this keeps their meaning without each test spelling out rows.
import type { Stance } from './stance'

type Named = { approvals?: string[]; refusals?: string[] }

export function stancesFrom(p: Named): Stance[] {
  const rows: Stance[] = []
  for (const name of p.approvals ?? []) rows.push({ seat: 0, name, stance: 'approved', counted: true })
  for (const name of p.refusals ?? []) rows.push({ seat: 0, name, stance: 'refused', counted: true })
  return rows
}

/** The fixture with its rows, and `approvals_count` as the bridge reports it (its counted approvals). */
export function withStances<T extends Named>(p: T): T & { stances: Stance[]; approvals_count: number } {
  const stances = stancesFrom(p)
  return { ...p, stances, approvals_count: stances.filter((s) => s.stance === 'approved').length }
}
