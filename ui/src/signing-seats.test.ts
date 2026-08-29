import { describe, expect, it } from 'vitest'
import { SigningSeats } from './signing-seats'

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
