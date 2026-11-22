// Who takes part in the vault's decisions, from the vault's own book.
//
// This is "transparent inside" turned into a figure, and it is the one thing a transparent multisig
// cannot show without handing the same information to everyone watching the chain.
//
// HONEST LIMIT, and the reason this counts approvals and not signatures: a proposal records WHO
// APPROVED (`approvals`), and nothing records who SIGNED. The ceremony trail has the aggregate
// signature, not the signers' identities - that is #290. So a "12 approved · 12 signed" reading
// would be half invented, and this returns approvals only until the record exists.
import type { Proposal } from './api'
import { myStance, stancesKnown } from './stance'

export type Participation = {
  /** The member's name, exactly as the vault records votes by. */
  name: string
  /** Proposals this member approved, out of `considered`; null when a coordinator older than #575 did
   *  not say who approved, so the screen shows a dash and never 0 of N. */
  approved: number | null
  /** 0-100, for the bar. Relative to the number of proposals considered, not to the top member. */
  pct: number
}

export type ParticipationSummary = {
  rows: Participation[]
  /** How many proposals the counts are over. Zero means there is nothing to show. */
  considered: number
}

/**
 * Count approvals per member over the most recent `limit` proposals that could be voted on.
 *
 * `roster` fixes the order and the membership: a member who approved nothing still gets a row (that
 * IS the information), and a name in the votes that is not a seat is ignored rather than inventing
 * a member - a rename can leave one behind, and votes are unauthenticated on the hosted helper
 * (#288), so a name is not proof of a person.
 *
 * Pure: the caller supplies the proposals and the roster, and nothing here reads a clock.
 */
export function participation(
  proposals: Proposal[],
  roster: string[],
  limit = 12,
): ParticipationSummary {
  // Only proposals a member could actually have voted on. A draft nobody could vote on would
  // depress everyone's count equally and mean nothing.
  const votable = proposals
    .filter((p) => p.state !== 'cancelled')
    .slice()
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, limit)

  const considered = votable.length
  // Seat N is roster[N-1]: the seat goes with the name, so two seats under one name are two rows.
  const seats = roster.map((name, i) => ({ name, seat: i + 1 })).filter((s) => s.name.trim().length > 0)
  const known = votable.every(stancesKnown)
  const rows = seats.map(({ name, seat }) => {
    if (!known) return { name, approved: null, pct: 0 }
    // The coordinator's counted stance of that seat (#575), not a name in a list of names.
    const approved = votable.filter((p) => myStance(p, { seat, name }) === 'approved').length
    return {
      name,
      approved,
      pct: considered === 0 ? 0 : Math.round((approved / considered) * 100),
    }
  })
  return { rows, considered }
}
