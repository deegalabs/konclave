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

export type Participation = {
  /** The member's name, exactly as the vault records votes by. */
  name: string
  /** Proposals this member approved, out of `considered`. */
  approved: number
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
  const seats = roster.filter((n) => n.trim().length > 0)
  const rows = seats.map((name) => {
    const approved = votable.filter((p) => p.approvals.includes(name)).length
    return {
      name,
      approved,
      pct: considered === 0 ? 0 : Math.round((approved / considered) * 100),
    }
  })
  return { rows, considered }
}
