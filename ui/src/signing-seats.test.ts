import { describe, expect, it } from 'vitest'
import { SigningSeats } from './signing-seats'

// The rejoin/seating handshake for a signing session (#49 Stage 3), lifted from NetVault. Fixed
// seats (from the DKG); each device announces its own, and stale tags for a seat are dropped so the
// distinct-seat count is exact and no duplicate seat can break signing.
describe('SigningSeats — signing-room seating (rejoin handshake)', () => {
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
    expect(seats.handleRejoin('b-tag', 2)).toBe(2)
    expect(seats.seatOf('b-tag')).toBe(2)
    expect(seats.seatCount()).toBe(2)
    expect(seats.handleRejoin('c-tag', 3)).toBe(3)
  })

  it('a reload (same seat, fresh tag) drops the stale tag — no duplicate seat, count stays exact', () => {
    let count = 0
    const seats = new SigningSeats('a', 1, (n) => { count = n })
    seats.handleRejoin('b-old', 2)
    expect(count).toBe(2)
    // Bob reloads: same seat 2, new tag. The stale tag must go, count must stay 2 (not 3).
    seats.handleRejoin('b-new', 2)
    expect(count).toBe(2)
    expect(seats.seatOf('b-old')).toBeUndefined()
    expect(seats.seatOf('b-new')).toBe(2)
    expect(seats.seatCount()).toBe(2)
  })

  it('never counts more distinct seats than were announced (cap is the roster, not the tags)', () => {
    const seats = new SigningSeats('a', 1)
    // three tags, but two of them claim the SAME seat 2 (a reconnect) -> 2 distinct seats.
    seats.handleRejoin('x', 2)
    seats.handleRejoin('y', 2)
    expect(seats.seatCount()).toBe(2)
    expect(seats.seatOf('x')).toBeUndefined() // supplanted by y for seat 2
    expect(seats.seatOf('y')).toBe(2)
  })
})
