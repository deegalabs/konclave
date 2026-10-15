import { describe, expect, it } from 'vitest'
import { ARM_SKEW_MS, ARM_TTL_MS, armExpiredBy, armIsLive, armOnArrival, claimConsent, consentAllows, emptyTally, giveConsent, makeSigningGate, newConsent, ownerArmed, tallyAfter, withdrawConsent, type SigningMode, type Tally } from './signing-gate'

// The governance policy for background signing (#49): a device never signs an unapproved payment;
// beyond that, auto signs approved ones on its own, manual also needs the owner to arm the payment.
describe('makeSigningGate - auto/manual signing policy', () => {
  const SH = 'deadbeef'

  it('never signs an unapproved payment, in either mode', async () => {
    for (const mode of ['auto', 'manual'] as SigningMode[]) {
      const gate = makeSigningGate({ mode: () => mode, isApproved: () => false, isArmed: () => true })
      expect(await gate({ sighash: SH })).toBe(false)
    }
  })

  it('auto: signs an approved payment automatically (no arming needed)', async () => {
    const gate = makeSigningGate({ mode: () => 'auto', isApproved: () => true, isArmed: () => false })
    expect(await gate({ sighash: SH })).toBe(true)
  })

  it('manual: an approved payment waits until the owner arms it', async () => {
    let armed = false
    const gate = makeSigningGate({ mode: () => 'manual', isApproved: () => true, isArmed: () => armed })
    expect(await gate({ sighash: SH })).toBe(false) // approved but not armed -> pending
    armed = true
    expect(await gate({ sighash: SH })).toBe(true) // owner armed it -> signs
  })

  it('reads the mode live, so a governance change takes effect on the next check', async () => {
    let mode: SigningMode = 'manual'
    const gate = makeSigningGate({ mode: () => mode, isApproved: () => true, isArmed: () => false })
    expect(await gate({ sighash: SH })).toBe(false) // manual, unarmed
    mode = 'auto' // a proposal flipped the vault to auto
    expect(await gate({ sighash: SH })).toBe(true)
  })

  it('arms per-payment (sighash), not globally', async () => {
    const armedSet = new Set<string>(['aaaa'])
    const gate = makeSigningGate({ mode: () => 'manual', isApproved: () => true, isArmed: (sh) => armedSet.has(sh) })
    expect(await gate({ sighash: 'aaaa' })).toBe(true)
    expect(await gate({ sighash: 'bbbb' })).toBe(false)
  })
})

// Consent should not outlive the act that gave it: a device left open on a signed payment must not
// contribute its share to a request that turns up hours later, with nobody watching.
describe('armIsLive - an arming has a deadline', () => {
  const t0 = 1_700_000_000_000

  it('is not live before the owner signs', () => {
    expect(armIsLive(null, t0)).toBe(false)
  })

  it('is live for the whole window, and not one moment past it', () => {
    expect(armIsLive(t0, t0)).toBe(true)
    expect(armIsLive(t0, t0 + ARM_TTL_MS)).toBe(true)
    expect(armIsLive(t0, t0 + ARM_TTL_MS + 1)).toBe(false)
  })

  it('covers a whole legitimate ceremony: build and prove, then the wait for the shares', () => {
    expect(armIsLive(t0, t0 + 2 * 60 * 1000 + 5 * 60 * 1000)).toBe(true)
  })

  it('reads a backwards clock jump as not armed, never as armed forever', () => {
    expect(armIsLive(t0, t0 - 1000)).toBe(false)
  })
})

// #626: another device's signature, judged when it arrives, by this device's clock.
describe('armOnArrival - a signature from another clock', () => {
  const now = 1_700_000_000_000
  it('counts one dated a little ahead, which is what a clock a second fast produces', () => {
    expect(armOnArrival(now + 1_400, now)).toBe('counts')
    expect(armOnArrival(now + ARM_SKEW_MS, now)).toBe('counts')
  })
  it('reports one dated further ahead than the bound, apart from an expired one', () => {
    expect(armOnArrival(now + ARM_SKEW_MS + 1, now)).toBe('ahead')
  })
  it('takes one however old by this clock, and leaves its expiry to the tally', () => {
    // Any cut by this device's clock let a device that opened later disagree with the others.
    expect(armOnArrival(now - ARM_TTL_MS - 1, now)).toBe('counts')
    expect(armOnArrival(now - 5 * ARM_TTL_MS, now)).toBe('counts')
  })
  it('keeps the bound small next to the window, so a fast clock stretches a signature by little', () => {
    expect(ARM_SKEW_MS).toBeLessThanOrEqual(ARM_TTL_MS / 5)
  })
})

describe('armExpiredBy - the tally forgets by the time of the next signature', () => {
  it('forgets a signature more than the window older than the one arriving, and only then', () => {
    expect(armExpiredBy(0, ARM_TTL_MS)).toBe(false)
    expect(armExpiredBy(0, ARM_TTL_MS + 1)).toBe(true)
    expect(armExpiredBy(5_000, 1_000)).toBe(false) // an older one arriving later forgets nothing
  })
})

describe('tallyAfter - the decision of who sends', () => {
  const T = 2
  const at0 = 1_000_000
  const step = (tally: Tally, seat: number, at: number) => tallyAfter(tally, seat, `s${seat}`, at, T)

  it('completes on the signature that brings a new seat to t, and holds the newest time of that quorum', () => {
    const a = step(emptyTally(), 1, at0)
    expect(a.completes).toBe(false)
    const b = step(a.tally, 2, at0 + 1000)
    expect(b.completes).toBe(true)
    expect(b.tally.completedAt).toBe(at0 + 1000)
  })

  it('holds the window from the newest signature of the quorum, not the one that completed it', () => {
    // With clocks apart, the signature that completes may carry an older time than one already in.
    const a = step(emptyTally(), 1, at0 + 60_000) // a fast clock
    const b = step(a.tally, 2, at0) // a slow one completes
    expect(b.completes).toBe(true)
    expect(b.tally.completedAt).toBe(at0 + 60_000)
  })

  it('before the quorum, a seat signing again adds nothing', () => {
    const a = step(emptyTally(), 1, at0)
    expect(step(a.tally, 1, at0 + 5000).completes).toBe(false)
  })

  it('ignores a seat\'s signature no newer than one already taken, even after it expired or was withdrawn', () => {
    const a = step(emptyTally(), 1, at0)
    const b = step(a.tally, 2, at0 + ARM_TTL_MS + 1) // seat 1 expires here
    expect(b.pruned).toEqual([1])
    expect(step(b.tally, 1, at0).ignored).toBe('older') // seat 1's old signature, posted again
    const withdrawn = { ...b.tally, entries: new Map(), completedAt: null }
    expect(step(withdrawn, 2, at0 + ARM_TTL_MS + 1).ignored).toBe('older')
  })

  it('ignores a signature that expired by the newest one taken', () => {
    const a = step(emptyTally(), 1, at0 + ARM_TTL_MS + 5000)
    expect(step(a.tally, 2, at0).ignored).toBe('expired')
  })

  it('no second completion within the window of the newest signature of the last quorum, one after it', () => {
    let m = step(emptyTally(), 1, at0)
    m = step(m.tally, 2, at0 + 1000) // completes, window from at0 + 1s
    const latch = m.tally.completedAt!
    // Seat 1's signature expires and it signs again inside the window: a new seat again, but held.
    const inside = step(m.tally, 1, latch + ARM_TTL_MS - 500)
    expect(inside.completes).toBe(false)
    // Exactly at the window's end it is still held, by the window alone (two signatures stand).
    const edge = step(inside.tally, 2, latch + ARM_TTL_MS)
    expect(edge.tally.entries.size).toBe(2)
    expect(edge.completes).toBe(false)
    // After it, both signatures of the last quorum have expired, and fresh ones complete again.
    const after = step(m.tally, 1, latch + ARM_TTL_MS + 1)
    expect(after.pruned).toEqual([1, 2])
    expect(step(after.tally, 2, latch + ARM_TTL_MS + 2).completes).toBe(true)
  })

  it('recovers when the named sender vanished: a new seat after the window completes (#334)', () => {
    let m = step(emptyTally(), 1, at0)
    m = step(m.tally, 2, at0 + 700) // completes; seat 2 is named and its tab closes
    m = step(m.tally, 1, at0 + 500_000) // seat 1 signs again within the window: held
    expect(m.completes).toBe(false)
    const back = step(m.tally, 2, at0 + 700 + ARM_TTL_MS + 30_000) // seat 2 reopens and signs
    expect(back.pruned).toEqual([2]) // its own signature of the last quorum expired by now
    expect(back.completes).toBe(true) // seat 1's signature given in the window still counts
  })

  // #626 review, round 3: completing used to need a seat new to the tally bringing it to exactly t.
  it('with more than t standing, the first signature past the window completes (N1c)', () => {
    let m = step(emptyTally(), 1, at0)
    m = step(m.tally, 2, at0 + 30_000) // completes; seat 2 is named and its tab closes
    m = step(m.tally, 3, at0 + 42_000) // a third member signs inside the window: held
    m = step(m.tally, 1, at0 + 600_600) // seat 1 again, still inside: held, three standing
    expect(m.completes).toBe(false)
    expect(m.tally.entries.size).toBe(3)
    const back = step(m.tally, 2, at0 + 30_000 + ARM_TTL_MS + 6_000) // seat 2 reopens and signs
    expect(back.tally.entries.size).toBe(3)
    expect(back.completes).toBe(true)
  })

  it('a seat signing again over its own standing signature completes past the window (N3)', () => {
    let m = step(emptyTally(), 1, at0)
    m = step(m.tally, 2, at0 + 30_000) // completes; seat 2 is named and vanishes
    m = step(m.tally, 1, at0 + 306_000) // both sign again inside the window: held
    m = step(m.tally, 2, at0 + 366_000)
    const again = step(m.tally, 1, at0 + 30_000 + ARM_TTL_MS + 36_000) // seat 1 again, its own still standing
    expect(again.pruned).toEqual([])
    expect(again.completes).toBe(true)
  })
})

// The device contributes its share only on its own owner's signature, within the owner's window.
// Nothing tested it before (#626 review): a later edit could drop the deadline with the suite green.
describe('ownerArmed - this device\'s own consent', () => {
  const at = 1_000_000
  const s = (armedProposal: string | null, armedAt: number | null, activeId: string | null) => ({ armedProposal, armedAt, activeId })
  it('holds for the open payment the owner signed, up to the end of the window', () => {
    expect(ownerArmed(s('p1', at, 'p1'), at)).toBe(true)
    expect(ownerArmed(s('p1', at, 'p1'), at + ARM_TTL_MS)).toBe(true)
  })
  it('not a moment past the window', () => {
    expect(ownerArmed(s('p1', at, 'p1'), at + ARM_TTL_MS + 1)).toBe(false)
  })
  it('not for another payment, nor with nothing open or nothing signed', () => {
    expect(ownerArmed(s('p1', at, 'p2'), at)).toBe(false)
    expect(ownerArmed(s('p1', at, null), at)).toBe(false)
    expect(ownerArmed(s(null, null, 'p1'), at)).toBe(false)
  })
})

// The owner's consent to one payment covers one transaction: the first one this device cleared under
// it (every check passed). Any other transaction under the same consent is refused and spends it, so
// the owner's Sign button returns for a new, deliberate signature.
describe('owner consent', () => {
  const T = 1_700_000_000_000
  const A = 'ab'.repeat(32)
  const B = 'cd'.repeat(32)

  it('allows the payment it was given for, inside its window, and nothing else', () => {
    const c = newConsent()
    expect(consentAllows(c, 'p1', T)).toBe(false)
    giveConsent(c, 'p1', T)
    expect(consentAllows(c, 'p1', T + 1000)).toBe(true)
    expect(consentAllows(c, 'p2', T + 1000)).toBe(false)
    expect(consentAllows(c, 'p1', T + ARM_TTL_MS + 1)).toBe(false)
  })

  it('the first transaction cleared under it is the only one it covers, in any letter case', () => {
    const c = newConsent()
    giveConsent(c, 'p1', T)
    expect(consentAllows(c, 'p1', T, A)).toBe(true)
    expect(claimConsent(c, 'p1', T, A.toUpperCase())).toBe(true)
    expect(claimConsent(c, 'p1', T + 5, A)).toBe(true) // the same transaction, a restarted ceremony
    expect(consentAllows(c, 'p1', T + 5, B)).toBe(false)
  })

  it('another transaction under it is refused and spends it; a new signature starts unbound', () => {
    const c = newConsent()
    giveConsent(c, 'p1', T)
    expect(claimConsent(c, 'p1', T, A)).toBe(true)
    expect(claimConsent(c, 'p1', T + 5, B)).toBe(false)
    expect(consentAllows(c, 'p1', T + 6)).toBe(false) // spent: the Sign button returns
    expect(consentAllows(c, 'p1', T + 6, A)).toBe(false)
    giveConsent(c, 'p1', T + 10)
    expect(claimConsent(c, 'p1', T + 10, B)).toBe(true)
  })

  it('a claim outside the consent binds nothing', () => {
    const c = newConsent()
    giveConsent(c, 'p1', T)
    expect(claimConsent(c, 'p2', T, A)).toBe(false)
    expect(claimConsent(c, 'p1', T + ARM_TTL_MS + 1, A)).toBe(false)
    expect(claimConsent(c, 'p1', T, B)).toBe(true) // still unbound
  })

  it('withdrawing ends it', () => {
    const c = newConsent()
    giveConsent(c, 'p1', T)
    claimConsent(c, 'p1', T, A)
    withdrawConsent(c)
    expect(consentAllows(c, 'p1', T)).toBe(false)
    expect(claimConsent(c, 'p1', T, A)).toBe(false)
  })
})
