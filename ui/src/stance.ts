// Who stands where on a proposal (#575), read from the answer and never from a list of names.
//
// The coordinator counts SEATS: a vote records the seat that cast it, and a vote recorded unsigned
// stops counting once the vault requires signatures. Its answer says, per seat, the stance and whether
// it counts (`stances`), and how many approvals count (`approvals_counted`). The app used to count
// `approvals.length` and find a member with `approvals.includes(name)`, so it could show "2 of 2"
// while the coordinator counted one. Every screen reads stances through this module now; a source
// scan (stance.test.ts) fails on the old reads anywhere else in `ui/src`.

export type StanceKind = 'approved' | 'refused' | 'none'

/** One seat's stance, as the coordinator (or the local bridge) reports it. */
export type Stance = {
  /** The seat, or 0 where no seat can be known (a vault with no roster, the local bridge). */
  seat: number
  name: string
  stance: StanceKind
  /** False for a stance recorded before the vault required signatures: shown apart, never counted. */
  counted: boolean
}

// `stances` is absent from a local bridge older than #575 and from a coordinator older than it on
// the web, where `mapNetProposal` keeps it null. Absent is UNKNOWN, not 'nobody has voted': the screens
// check `stancesKnown` before they list people or offer a vote. The readers below treat it as no rows,
// never as a crash.
type HasStances = { stances?: Stance[] | null }
const rows = (p: HasStances): Stance[] => p.stances ?? []

/** Whether the answer said who stands where. False for an older coordinator (#575). */
export const stancesKnown = (p: HasStances): boolean => p.stances != null

/** Who this device is: its seat when it knows it, else its member name. */
export type Me = { seat?: number; name: string | null }

const same = (a: string, b: string) => a.trim() === b.trim()

/**
 * The row of one member. By seat when both sides have one. By name ONLY on rows without a seat
 * (the coordinator cannot know seats on a vault with no roster; the bridge records names), or when
 * this device does not know its seat yet and exactly one row carries its name: two seats under one
 * name are two members, and a guess between them would be the defect again.
 */
export function rowOf(p: HasStances, me: Me): Stance | null {
  if (me.seat !== undefined) {
    const bySeat = rows(p).find((s) => s.seat === me.seat)
    if (bySeat) return bySeat
  }
  const name = me.name
  if (!name || !name.trim()) return null
  const named = rows(p).filter((s) => same(s.name, name))
  return named.length === 1 ? named[0] ?? null : null
}

/** This member's COUNTED stance: an uncounted one is not a vote yet, they still have to cast it. */
export function myStance(p: HasStances, me: Me): StanceKind | null {
  // Unknown is not 'none': an answer that did not say who stands where claims nothing about this member.
  if (!stancesKnown(p)) return null
  const row = rowOf(p, me)
  if (!row) return me.name ? 'none' : null
  return row.counted ? row.stance : 'none'
}

/** Whether this member has an approval or refusal that counts. */
export function hasVoted(p: HasStances, me: Me): boolean {
  // Unknown is not 'has not voted' and not 'has voted': callers check `stancesKnown` before they offer
  // or withhold a vote.
  const s = myStance(p, me)
  return s === 'approved' || s === 'refused'
}

/** A stance this member recorded that does not count (approve again, signed, to make it count). */
export function myUncounted(p: HasStances, me: Me): StanceKind | null {
  const row = rowOf(p, me)
  return row && !row.counted && row.stance !== 'none' ? row.stance : null
}

/** Names whose stance is `kind` and counts, in seat order. */
export function countedNames(p: HasStances, kind: Exclude<StanceKind, 'none'>): string[] {
  return rows(p).filter((s) => s.counted && s.stance === kind).map((s) => s.name)
}

/** Names whose stance is `kind` but does NOT count (recorded before signatures were required). */
export function uncountedNames(p: HasStances, kind: Exclude<StanceKind, 'none'>): string[] {
  return rows(p).filter((s) => !s.counted && s.stance === kind).map((s) => s.name)
}

/**
 * Members with no counted stance. Where the answer has a row per seat, those rows; where it has rows
 * only for who voted (no roster, the bridge), the members the caller lists that have no counted row.
 */
export function pendingNames(p: HasStances, members: string[]): string[] {
  if (rows(p).some((s) => s.seat > 0)) {
    return rows(p).filter((s) => !s.counted || s.stance === 'none').map((s) => s.name)
  }
  return members.filter((m) => !rows(p).some((s) => s.counted && s.stance !== 'none' && same(s.name, m)))
}

/**
 * The people to list, each with its row: every row the answer has (two seats under one name are two
 * rows), then a `none` row for each member the caller lists that no row names (the bridge reports
 * only who voted).
 */
export function people(p: HasStances, members: string[]): Stance[] {
  const out = rows(p).slice()
  for (const m of members) {
    if (m.trim() && !out.some((s) => same(s.name, m))) out.push({ seat: 0, name: m, stance: 'none', counted: false })
  }
  return out
}

/** The approval count as a screen shows it: the coordinator's number, or a dash when the coordinator
 *  did not say (an older one, #575). Never a count the app makes itself. */
export function approvalsShown(p: { approvals_count: number | null }): number | string {
  return p.approvals_count ?? '—'
}
