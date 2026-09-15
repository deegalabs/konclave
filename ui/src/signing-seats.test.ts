import { describe, expect, it } from 'vitest'
import { SigningSeats , seatHolder } from './signing-seats'

// The rejoin/seating handshake for a signing session (#49 Stage 3), lifted from NetVault. Fixed
// seats (from the DKG); each device announces its own, and stale tags for a seat are dropped so the
// distinct-seat count is exact and no duplicate seat can break signing. Since #392, taking over a
// seat another tag holds requires a PROVEN rejoin (a signature by that seat's share).
describe('SigningSeats - signing-room seating (rejoin handshake)', () => {
  it('seats itself on construction (count 1) and announces its own seat', () => {
    let count = 0
    const seats = new SigningSeats('me', 2, (n) => { count = n })
    expect(count).toBe(1)
    expect(seats.mySeat()).toBe(2)
    expect(seats.tag()).toBe('me')
    expect(seats.seatOf('me')).toBe(2)
    expect(seats.announcement()).toEqual({ type: 'rejoin', seat: 2 })
  })

  it('adds peers by their declared seat, counting distinct seats', () => {
    const seats = new SigningSeats('a-tag', 1)
    expect(seats.handleRejoin('b-tag', 2, true)).toBe(2)
    expect(seats.seatOf('b-tag')).toBe(2)
    expect(seats.seatCount()).toBe(2)
    expect(seats.handleRejoin('c-tag', 3, true)).toBe(3)
  })

  it('a PROVEN reload (same seat, fresh tag) drops the stale tag - no duplicate seat, count stays exact', () => {
    let count = 0
    const seats = new SigningSeats('a', 1, (n) => { count = n })
    seats.handleRejoin('b-old', 2, true)
    expect(count).toBe(2)
    // Bob reloads: same seat 2, new tag, PROVEN (only Bob's share can sign it). Stale tag goes.
    seats.handleRejoin('b-new', 2, true)
    expect(count).toBe(2)
    expect(seats.seatOf('b-old')).toBeUndefined()
    expect(seats.seatOf('b-new')).toBe(2)
    expect(seats.seatCount()).toBe(2)
  })

  // THE #392 RULE (A4 seat-hijack): an outsider knows the room but not seat 2's share, so its rejoin
  // is UNPROVEN and must NEVER evict the legitimate holder.
  it('an UNPROVEN rejoin never evicts an established seat', () => {
    const seats = new SigningSeats('a', 1)
    seats.handleRejoin('b', 2, true) // Bob legitimately holds seat 2
    seats.handleRejoin('attacker', 2, false) // outsider claims seat 2, unproven
    expect(seats.seatOf('b')).toBe(2) // Bob is NOT evicted
    expect(seats.seatOf('attacker')).toBeUndefined() // the outsider does not take the seat
    expect(seats.seatCount()).toBe(2)
  })

  it('an UNPROVEN rejoin may still seat an EMPTY seat (compat for older builds)', () => {
    const seats = new SigningSeats('a', 1)
    expect(seats.handleRejoin('b', 2, false)).toBe(2) // seat 2 was empty -> allowed
    expect(seats.seatOf('b')).toBe(2)
  })
})

// `seatHolder` is the eviction rule itself, pulled out so `/net` and the background signer cannot
// answer it differently - which is how the hijack stayed open on `/net` after #401 closed it here
// (#424). If this is ever inlined again, it will drift again.
describe('seatHolder — who would be evicted (#424)', () => {
  const table = new Map([['tag-a', 1], ['tag-b', 2]])

  it('names the other tag holding the seat: taking it is an eviction', () => {
    expect(seatHolder(table, 'fresh-tag', 1)).toBe('tag-a')
  })

  it('is undefined for an EMPTY seat: taking it evicts nobody', () => {
    expect(seatHolder(table, 'fresh-tag', 3)).toBeUndefined()
  })

  it('is undefined when the tag already holds that seat: a repeat is not an eviction', () => {
    // A device re-announcing itself (a duplicate relay delivery) must not be read as taking over
    // from itself, or a legitimate repeat would need a proof it has no reason to carry.
    expect(seatHolder(table, 'tag-a', 1)).toBeUndefined()
  })

  it('is undefined on an empty table', () => {
    expect(seatHolder(new Map(), 'tag-a', 1)).toBeUndefined()
  })
})

// Whether a seat was PROVEN is remembered, not just used and thrown away (#399).
//
// `handleRejoin` already receives `proven` and already uses it for the one decision it was written
// for: only a proven rejoin may evict an established seat (#392's A4). What it did not do is keep
// the answer, and the residual A4 does not leave is a coordinator problem rather than a seating one.
//
// A truly EMPTY seat may still be taken by an unproven rejoin, deliberately, so older builds keep
// working. The coordinator then builds its threshold set from the lowest `t` seats that commited,
// so an outsider holding a low empty seat gets picked and its bogus commitment lands in the
// aggregate. The signature does not verify and the send fails. No funds move; the ceremony dies.
//
// The coordinator can only prefer proven seats if someone remembers which ones they are.
describe('the seating remembers which seats proved themselves', () => {
  it('a proven rejoin is recorded as proven', () => {
    const s = new SigningSeats('me', 2)
    s.handleRejoin('peer', 1, true)
    expect(s.isProven('peer')).toBe(true)
  })

  it('an unproven rejoin seats but is NOT recorded as proven', () => {
    const s = new SigningSeats('me', 2)
    s.handleRejoin('outsider', 1, false)
    expect(s.seatOf('outsider')).toBe(1) // still seated: empty seats stay open for old builds
    expect(s.isProven('outsider')).toBe(false)
  })

  it('this device counts as proven to itself', () => {
    // It holds the share. Anything else would make a device deprioritise its own commitment.
    const s = new SigningSeats('me', 3)
    expect(s.isProven('me')).toBe(true)
  })

  it('a proven takeover carries the proof to the new tag and drops the old one', () => {
    // A reloaded device rejoins with a FRESH tag. The evicted tag must not keep counting as proven,
    // or a stale entry outlives the seat it described.
    const s = new SigningSeats('me', 2)
    s.handleRejoin('old', 1, true)
    s.handleRejoin('fresh', 1, true)
    expect(s.isProven('fresh')).toBe(true)
    expect(s.isProven('old')).toBe(false)
    expect(s.seatOf('old')).toBeUndefined()
  })

  it('an unknown tag is not proven', () => {
    expect(new SigningSeats('me', 1).isProven('nobody')).toBe(false)
  })
})
