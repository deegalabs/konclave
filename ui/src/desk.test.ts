import { describe, expect, it } from 'vitest'
import { rankDesk, bandOf, isOpen } from './desk'
import type { Proposal } from './api'

// A proposal with only the fields the desk reads. Everything else is filler.
function p(o: Partial<Proposal> & { id: string }): Proposal {
  return {
    vault_id: 'v',
    kind: 'payment',
    state: 'awaiting',
    proposer: 'ana',
    value_zat: 1_000_000,
    value_zec: '0.01',
    is_public: false,
    approvals: [],
    refusals: [],
    approvals_count: 0,
    ...o,
  } as Proposal
}

const ids = (d: ReturnType<typeof rankDesk>) => d.items.map((i) => i.p.id)

describe('isOpen', () => {
  it('counts only proposals that still hold funds and can still move', () => {
    expect(isOpen(p({ id: 'a', state: 'awaiting' }))).toBe(true)
    expect(isOpen(p({ id: 'b', state: 'ready' }))).toBe(true)
    for (const s of ['sent', 'confirmed', 'expired', 'cancelled', 'rejected', 'superseded']) {
      expect(isOpen(p({ id: 'x', state: s }))).toBe(false)
    }
  })
})

describe('bandOf', () => {
  it('puts a ready proposal I approved above everything: my signature is what is missing', () => {
    expect(bandOf(p({ id: 'a', state: 'ready', approvals: ['dan'] }), 'dan')).toBe('sign')
  })

  it('separates a ready proposal I did not approve - the others unblock it, not me', () => {
    expect(bandOf(p({ id: 'a', state: 'ready', approvals: ['ana', 'bob'] }), 'dan')).toBe('wait')
  })

  it('asks for my vote only when I have not voted', () => {
    expect(bandOf(p({ id: 'a', approvals: [] }), 'dan')).toBe('vote')
    expect(bandOf(p({ id: 'a', approvals: ['dan'] }), 'dan')).toBe('voted')
  })

  it('treats a refusal as a vote: I already answered, it is not waiting on me', () => {
    expect(bandOf(p({ id: 'a', refusals: ['dan'] }), 'dan')).toBe('voted')
  })

  it('falls back to state alone when the identity is unknown, and never claims otherwise', () => {
    expect(bandOf(p({ id: 'a', state: 'ready' }), null)).toBe('sign')
    expect(bandOf(p({ id: 'a', state: 'awaiting' }), null)).toBe('vote')
    expect(rankDesk([p({ id: 'a' })], null, 2).personal).toBe(false)
    expect(rankDesk([p({ id: 'a' })], 'dan', 2).personal).toBe(true)
  })
})

describe('rankDesk - the bugs the old dashboard had', () => {
  it('BUG: a ready proposal used to vanish the moment someone opened a new one', () => {
    // Old code: `const firstReady = !pending ? (ready[0] ?? null) : null` - one awaiting proposal
    // hid every ready one, so the member holding up a signature never saw it.
    const d = rankDesk(
      [
        p({ id: 'new', state: 'awaiting' }),
        p({ id: 'ready', state: 'ready', approvals: ['dan', 'ana'] }),
      ],
      'dan',
      2,
    )
    expect(ids(d)).toEqual(['ready', 'new'])
    expect(d.items[0]!.band).toBe('sign')
  })

  it('BUG: the pick was array order, so a proposal expiring in 2h sat behind one expiring in 60h', () => {
    const d = rankDesk(
      [
        p({ id: 'far', expiry_unix: 1_000_000 }),
        p({ id: 'soon', expiry_unix: 10_000 }),
        p({ id: 'mid', expiry_unix: 500_000 }),
      ],
      'dan',
      2,
    )
    expect(ids(d)).toEqual(['soon', 'mid', 'far'])
  })

  it('BUG: "needs you" was said to a member who had already voted', () => {
    const d = rankDesk(
      [
        p({ id: 'mine', approvals: ['dan'], expiry_unix: 10 }),
        p({ id: 'theirs', approvals: ['ana'], expiry_unix: 999 }),
      ],
      'dan',
      2,
    )
    // Even though `mine` expires far sooner, the one that actually needs a vote comes first.
    expect(ids(d)).toEqual(['theirs', 'mine'])
    expect(d.items[0]!.band).toBe('vote')
    expect(d.items[1]!.band).toBe('voted')
  })
})

describe('rankDesk - ordering', () => {
  it('orders the four bands: sign, vote, wait, voted', () => {
    const d = rankDesk(
      [
        p({ id: 'voted', state: 'awaiting', approvals: ['dan'] }),
        p({ id: 'wait', state: 'ready', approvals: ['ana', 'bob'] }),
        p({ id: 'vote', state: 'awaiting', approvals: ['ana'] }),
        p({ id: 'sign', state: 'ready', approvals: ['dan', 'ana'] }),
      ],
      'dan',
      2,
    )
    expect(ids(d)).toEqual(['sign', 'vote', 'wait', 'voted'])
  })

  it('breaks an expiry tie by age, oldest first', () => {
    const d = rankDesk(
      [
        p({ id: 'younger', expiry_unix: 100, created_at: 50 }),
        p({ id: 'older', expiry_unix: 100, created_at: 10 }),
      ],
      'dan',
      2,
    )
    expect(ids(d)).toEqual(['older', 'younger'])
  })

  it('sorts a proposal with no expiry after every proposal that has one', () => {
    const d = rankDesk(
      [p({ id: 'forever' }), p({ id: 'dated', expiry_unix: 9_999_999 })],
      'dan',
      2,
    )
    expect(ids(d)).toEqual(['dated', 'forever'])
  })

  it('is stable across polls when everything else ties', () => {
    const a = p({ id: 'aaa' })
    const b = p({ id: 'bbb' })
    expect(ids(rankDesk([a, b], 'dan', 2))).toEqual(['aaa', 'bbb'])
    expect(ids(rankDesk([b, a], 'dan', 2))).toEqual(['aaa', 'bbb'])
  })
})

describe('rankDesk - "you are the last"', () => {
  it('flags the case where signing SENDS, so the click is never a surprise', () => {
    const d = rankDesk([p({ id: 'a', state: 'ready', approvals: ['dan', 'ana'] })], 'dan', 2)
    expect(d.items[0]!.last).toBe(true)
  })

  it('does not flag it when the quorum is not met yet', () => {
    const d = rankDesk([p({ id: 'a', state: 'ready', approvals: ['dan'] })], 'dan', 3)
    expect(d.items[0]!.last).toBe(false)
  })

  it('never flags it for a member who did not approve, or with no known identity', () => {
    expect(rankDesk([p({ id: 'a', state: 'ready', approvals: ['ana', 'bob'] })], 'dan', 2).items[0]!.last).toBe(false)
    expect(rankDesk([p({ id: 'a', state: 'ready', approvals: ['ana', 'bob'] })], null, 2).items[0]!.last).toBe(false)
  })

  it('does not flag an unknown quorum as complete', () => {
    const d = rankDesk([p({ id: 'a', state: 'ready', approvals: ['dan'] })], 'dan', 0)
    expect(d.items[0]!.last).toBe(false)
  })
})

describe('rankDesk - counting', () => {
  it('counts every open proposal, not just the ones the queue renders', () => {
    const many = Array.from({ length: 7 }, (_, i) => p({ id: `p${i}`, expiry_unix: i }))
    const d = rankDesk([...many, p({ id: 'sent', state: 'sent' })], 'dan', 2)
    expect(d.open).toBe(7)
    expect(d.items).toHaveLength(7)
  })

  it('returns an empty desk rather than a fabricated one', () => {
    const d = rankDesk([p({ id: 'a', state: 'confirmed' })], 'dan', 2)
    expect(d.items).toEqual([])
    expect(d.open).toBe(0)
  })
})
