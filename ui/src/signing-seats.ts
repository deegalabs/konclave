// Seating for a SIGNING session (issue #49, Stage 3 wiring). In a signing room the seats are FIXED
// (they were assigned by the DKG); a device that (re)joins announces its OWN, already-known seat and
// every device rebuilds the tag->seat table from those announcements. This is the `rejoin` handshake
// NetVault's beginSign runs - lifted here so the app-level background signer can seat devices on the
// vault's signing room without being the /net screen.
//
// It is deliberately tiny and pure: it maps relay tags to 1-based FROST seats and provides the
// `seatOf`/`mySeat` lookups the SigningMachine needs. It never touches shares or crypto.

/**
 * The tag OTHER than `fromTag` that currently holds `seat`, if any.
 *
 * A rejoin naming an occupied seat is an EVICTION, and only a PROVEN one may do it (#392). This
 * lives outside the class because `/net` keeps its own tag->seat map (it also carries the DKG's
 * `encPub` per seat, which this class does not), and the two drifting apart is exactly how the
 * hijack stayed open there after #401 closed it here (#424). One rule, one place.
 */
export function seatHolder(
  byTag: ReadonlyMap<string, number>,
  fromTag: string,
  seat: number,
): string | undefined {
  return [...byTag.entries()].find(([tag, s]) => s === seat && tag !== fromTag)?.[0]
}

/** The wire message a device broadcasts to announce its seat when joining a signing room. */
export interface RejoinMsg {
  type: 'rejoin'
  seat: number
}

export class SigningSeats {
  private readonly myTag: string
  private readonly mySeatNum: number
  private readonly byTag = new Map<string, number>() // relay tag -> 1-based seat
  /** Tags whose rejoin was PROVEN by a signature from that seat's own share (#392).
   *
   *  `proven` was already computed on every rejoin and then thrown away, because the only decision
   *  it fed was eviction. Keeping it is what lets the coordinator prefer proven seats when it builds
   *  the threshold set (#399): an unproven rejoin may still take a truly EMPTY seat, on purpose, so
   *  older builds keep working, and a coordinator that picks the lowest seats can then pick an
   *  outsider's bogus commitment and produce a signature that does not verify. */
  private readonly proven = new Set<string>()
  private readonly onCount?: (n: number) => void

  constructor(myTag: string, mySeat: number, onCount?: (n: number) => void) {
    this.myTag = myTag
    this.mySeatNum = mySeat
    this.byTag.set(myTag, mySeat) // seat myself immediately
    this.proven.add(myTag) // this device holds the share; anything else deprioritises its own commit
    this.onCount = onCount
    onCount?.(1)
  }

  /** The `rejoin` this device sends on joining - its OWN seat, bound to its KeyPackage identifier. */
  announcement(): RejoinMsg {
    return { type: 'rejoin', seat: this.mySeatNum }
  }

  /**
   * Apply a peer's `rejoin`. `proven` is whether the caller verified a signature by this seat's own
   * share (#392): only a PROVEN rejoin may TAKE OVER a seat another tag already holds - a reloaded
   * device rejoining with a fresh tag, which only that seat's share-holder can sign. An UNPROVEN
   * rejoin (an outsider, or an older build) may seat an EMPTY seat but NEVER evicts an established
   * one, which closes the seat-hijack (A4). Returns the distinct-seat count.
   */
  handleRejoin(fromTag: string, seat: number, proven: boolean): number {
    // Is this seat already held by a DIFFERENT tag? Taking it over is an eviction, and only a proven
    // rejoin (a real signature by this seat's share - a legit reload) may do it. An unproven claim on
    // an occupied seat is ignored, never evicting the holder (A4 seat-hijack, #392).
    const heldBy = seatHolder(this.byTag, fromTag, seat)
    if (heldBy !== undefined) {
      if (!proven) return this.seatCount() // occupied + unproven -> never evict
      this.byTag.delete(heldBy) // proven takeover: the seat's own share-holder, reloaded
      this.proven.delete(heldBy) // and the evicted tag stops counting as proven with it
    }
    this.byTag.set(fromTag, seat)
    if (proven) this.proven.add(fromTag)
    else this.proven.delete(fromTag)
    const count = this.seatCount()
    this.onCount?.(count)
    return count
  }

  /** 1-based seat of a relay tag, or undefined if that tag has not announced yet. */
  seatOf(tag: string): number | undefined {
    return this.byTag.get(tag)
  }

  /** Did this tag prove it holds its seat's share (#392/#399)? False for a tag that only claimed an
   *  empty seat, and false for one that never announced. The coordinator prefers these when it picks
   *  the threshold set, so an unproven claim on an empty low seat cannot poison the aggregate. */
  isProven(tag: string): boolean {
    return this.proven.has(tag)
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
