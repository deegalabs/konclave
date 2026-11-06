// The trust panel's facts (#244, #308): who sees what and who can do what, for one vault, from
// the one fact this device holds about it: private (the vault holds the per-vault secret S, so the
// coordinator's private reads are gated and the signing room derives from S) or open (a leaked
// link reads the books, the proposals and the memos through the coordinator).
//
// What the device does NOT hold is said as such: whether the write gate is on (it turns on at a
// seat's first unlock on an updated app, a coordinator-side fact), and whether every seat has
// registered its device key (until then the relay carries a payment's content in the clear).
// Each cell is a short word the screen prints; the clauses live in the limits under the table.

export type Party = 'members' | 'server' | 'relay' | 'link'
export type Cell = 'yes' | 'no' | 'metadata' | 'quorum' | 'builds' | 'keeps' | 'sealedWhenRegistered' | 'untilUnlock'
export type TrustRow = { what: 'books' | 'memos' | 'payment' | 'move' | 'propose'; cells: Record<Party, Cell> }

export type TrustFacts = { secured: boolean; threshold: number; total: number }

export function trustRows(f: TrustFacts): TrustRow[] {
  const open = !f.secured
  return [
    // The balance and the movements: members read them; the coordinator holds the viewing key, so
    // it reads them too; the relay sees sealed or public material only; a bare link reads them on
    // an open vault, and on a private one gets the metadata that stays open by design (the
    // vault's address, how many members, how many must approve).
    { what: 'books', cells: { members: 'yes', server: 'yes', relay: 'no', link: open ? 'yes' : 'metadata' } },
    // The memos (payslips) decrypt with the viewing key: members and the coordinator.
    { what: 'memos', cells: { members: 'yes', server: 'yes', relay: 'no', link: open ? 'yes' : 'no' } },
    // Who a payment pays and how much: the proposals are gated like the books, so a link reads
    // them on an open vault; the relay carries the signing request sealed only once every seat
    // has registered its device key.
    { what: 'payment', cells: { members: 'yes', server: 'yes', relay: 'sealedWhenRegistered', link: open ? 'yes' : 'no' } },
    // Moving money: a quorum of shares; the coordinator never holds one, but builds what the
    // quorum signs; nobody else.
    { what: 'move', cells: { members: 'quorum', server: 'builds', relay: 'no', link: 'no' } },
    // Proposing, voting, renaming: the coordinator keeps the record and checks its own gate; the
    // link may write until a member's first unlock turns the gate on, which this device cannot see.
    { what: 'propose', cells: { members: 'yes', server: 'keeps', relay: 'no', link: 'untilUnlock' } },
  ]
}
