import { describe, expect, it } from 'vitest'
import { participation } from './participation'
import type { Proposal } from './api'

const p = (o: Partial<Proposal> & { id: string }): Proposal => ({
  vault_id: 'v', kind: 'payment', state: 'confirmed', proposer: 'dan',
  value_zat: 1, value_zec: '0.00000001', is_public: false,
  approvals: [], refusals: [], approvals_count: 0, created_at: 0, ...o,
} as Proposal)

describe('participation', () => {
  it('counts approvals per member over the proposals considered', () => {
    const r = participation([
      p({ id: 'a', approvals: ['dan', 'bob'], created_at: 3 }),
      p({ id: 'b', approvals: ['dan'], created_at: 2 }),
      p({ id: 'c', approvals: ['dan', 'bob'], created_at: 1 }),
    ], ['dan', 'bob'])
    expect(r.considered).toBe(3)
    expect(r.rows).toEqual([
      { name: 'dan', approved: 3, pct: 100 },
      { name: 'bob', approved: 2, pct: 67 },
    ])
  })

  it('keeps a member who approved nothing - that IS the information', () => {
    const r = participation([p({ id: 'a', approvals: ['dan'] })], ['dan', 'maicon'])
    expect(r.rows[1]).toEqual({ name: 'maicon', approved: 0, pct: 0 })
  })

  it('ignores a vote from a name that is not a seat', () => {
    // A rename can leave one behind, and votes are unauthenticated on the helper (#288), so a name
    // in the list is not proof of a member.
    const r = participation([p({ id: 'a', approvals: ['dan', 'ghost'] })], ['dan'])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.approved).toBe(1)
  })

  it('takes the most recent proposals, not the first ones the backend returned', () => {
    const old = Array.from({ length: 5 }, (_, i) => p({ id: `old${i}`, approvals: [], created_at: i }))
    const recent = Array.from({ length: 3 }, (_, i) => p({ id: `new${i}`, approvals: ['dan'], created_at: 100 + i }))
    const r = participation([...old, ...recent], ['dan'], 3)
    expect(r.considered).toBe(3)
    expect(r.rows[0]!.approved).toBe(3)
  })

  it('excludes a cancelled proposal nobody could vote on', () => {
    const r = participation([
      p({ id: 'a', approvals: ['dan'], created_at: 2 }),
      p({ id: 'b', state: 'cancelled', approvals: [], created_at: 1 }),
    ], ['dan'])
    expect(r.considered).toBe(1)
    expect(r.rows[0]!.pct).toBe(100)
  })

  it('returns zeros rather than dividing by zero on an empty book', () => {
    const r = participation([], ['dan', 'bob'])
    expect(r.considered).toBe(0)
    expect(r.rows.every((x) => x.approved === 0 && x.pct === 0)).toBe(true)
  })

  it('drops blank seats instead of drawing an unnamed row', () => {
    const r = participation([p({ id: 'a', approvals: ['dan'] })], ['dan', '', '  '])
    expect(r.rows).toHaveLength(1)
  })
})
