// Seating for a SIGNING session (issue #49, Stage 3 wiring). In a signing room the seats are FIXED
// (they were assigned by the DKG); a device that (re)joins announces its OWN, already-known seat and
// every device rebuilds the tag->seat table from those announcements. This is the `rejoin` handshake
// NetVault's beginSign runs - lifted here so the app-level background signer can seat devices on the
// vault's signing room without being the /net screen.
//
// It is deliberately tiny and pure: it maps relay tags to 1-based FROST seats and provides the
// `seatOf`/`mySeat` lookups the SigningMachine needs. It never touches shares or crypto.

/** The wire message a device broadcasts to announce its seat when joining a signing room. */
export interface RejoinMsg {
  type: 'rejoin'
  seat: number
}

export class SigningSeats {
  private readonly myTag: string
  private readonly mySeatNum: number
  private readonly byTag = new Map<string, number>() // relay tag -> 1-based seat
  private readonly onCount?: (n: number) => void

  constructor(myTag: string, mySeat: number, onCount?: (n: number) => void) {
    this.myTag = myTag
    this.mySeatNum = mySeat
    this.byTag.set(myTag, mySeat) // seat myself immediately
    this.onCount = onCount
    onCount?.(1)
  }

  /** The `rejoin` this device sends on joining - its OWN seat, bound to its KeyPackage identifier. */
  announcement(): RejoinMsg {
    return { type: 'rejoin', seat: this.mySeatNum }
  }

  /**
   * Apply a peer's `rejoin`: re-seat by the DECLARED seat, dropping any stale tag that used to hold
   * that seat (a reloaded device rejoins with a fresh tag but the same seat), so each seat has
   * exactly one presence - the count is distinct SEATS (never > n) and the table has no duplicate
   * seat that would break signing. Returns the distinct-seat count.
   */
  handleRejoin(fromTag: string, seat: number): number {
    for (const [tag, s] of this.byTag.entries()) {
      if (s === seat && tag !== fromTag) this.byTag.delete(tag)
    }
    this.byTag.set(fromTag, seat)
    const count = this.seatCount()
    this.onCount?.(count)
    return count
  }

  /** 1-based seat of a relay tag, or undefined if that tag has not announced yet. */
  seatOf(tag: string): number | undefined {
    return this.byTag.get(tag)
  }

  /** This device's own 1-based seat. */
  mySeat(): number {
    return this.mySeatNum
  }

  /** This device's relay tag. */
  tag(): string {
    return this.myTag
  }

  /** How many distinct seats are present (this device + every peer that has rejoined). */
  seatCount(): number {
    return new Set(this.byTag.values()).size
  }
}
