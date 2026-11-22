// @vitest-environment jsdom
// #575. A coordinator older than the count sends no `stances`. Unknown is not "nobody voted": every
// reader that makes a claim about a member from stances must say nothing when the answer is unknown.
import { describe, expect, it, vi } from 'vitest'
import type { Proposal } from './api'
import { withStances } from './test-stances'
import { bandOf, lineKey, personalBand, rankDesk } from './desk'
import { changesSince } from './since-last'
import { participation } from './participation'
import { hasVoted, myStance, stancesKnown } from './stance'

localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.selectedVault', 'v')
const netCreateProposal = vi.hoisted(() => vi.fn())
const failure = vi.hoisted(() => vi.fn())
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), createProposal: netCreateProposal, lastHelperPostFailure: failure, listMembers: async () => ['Alice', 'Bob'] }))
vi.mock('./device-key', async (orig) => ({ ...(await orig<typeof import('./device-key')>()), signGovernanceWrite: () => ({ proof_seat: 1 }) as never }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
const { createProposal } = await import('./api')
const { setUnlockedShare } = await import('./session')

const base = { vault_id: 'v', proposer: 'Alice', is_public: false, refusals: [], kind: 'payment', to_address: 'u1x', value_zat: 1000, value_zec: '0.00001', created_at: 10, expiry_unix: 9_999_999_999 }
// Alice proposed, so she approved. The old coordinator does not say so.
const unknown = (id: string, state: string): Proposal => ({ ...base, id, state, approvals: ['Alice'], approvals_count: null, stances: null }) as unknown as Proposal
const known = (id: string, state: string): Proposal => withStances({ ...base, id, state, approvals: ['Alice'] }) as unknown as Proposal

describe('unknown stances claim nothing about a member', () => {
  it('the shared readers say unknown, not "has not voted"', () => {
    const p = unknown('a', 'awaiting')
    expect(stancesKnown(p)).toBe(false)
    expect(myStance(p, { name: 'Alice' })).toBeNull()
    expect(hasVoted(p, { name: 'Alice' })).toBe(false)
    expect(stancesKnown(known('a', 'awaiting'))).toBe(true)
  })

  it('the desk is impersonal: no "your vote", and a ready proposal is not moved to wait', () => {
    expect(personalBand(unknown('a', 'awaiting'), 'Alice')).toBeNull()
    expect(bandOf(unknown('r', 'ready'), 'Alice')).toBe('sign')
    const d = rankDesk([unknown('a', 'awaiting'), unknown('r', 'ready')], 'Alice', 2)
    expect(d.personal).toBe(false)
    expect(d.items.map((i) => [i.p.id, i.band])).toEqual([['r', 'sign'], ['a', 'vote']])
    // With stances nothing changes: Alice approved the awaiting one, so it waits on others.
    const k = rankDesk([known('a', 'awaiting')], 'Alice', 2)
    expect(k.personal).toBe(true)
    expect(k.items[0]!.band).toBe('voted')
  })

  it('the main card\u2019s line is neutral when the desk is impersonal, personal when stances are known', () => {
    expect(lineKey('vote', true)).toBe('desk.line.vote')
    expect(lineKey('sign', true)).toBe('desk.line.sign')
    expect(lineKey('vote', false)).toBe('proposals.awaitingApproval')
    expect(lineKey('sign', false)).toBe('dashboard.readyToSign')
    // The desk itself decides which: unknown stances give an impersonal desk, known ones a personal one.
    const personalOf = (p: Proposal) => lineKey(rankDesk([p], 'Bob', 2).items[0]!.band, rankDesk([p], 'Bob', 2).personal)
    expect(personalOf(unknown('a', 'awaiting'))).toBe('proposals.awaitingApproval')
    expect(personalOf(known('a', 'awaiting'))).toBe('desk.line.vote')
  })

  it('"What changed" does not say a proposal arrived for this member', () => {
    expect(changesSince({}, [unknown('a', 'awaiting')], 'Alice')![0]!.kind).toBe('new')
    // With stances it still does: Bob has no counted stance, so the vote waits on him.
    expect(changesSince({}, [known('b', 'awaiting')], 'Bob')![0]!.kind).toBe('arrived')
  })

  it('participation shows unknown, never 0 of N', () => {
    const rows = participation([unknown('a', 'ready')], ['Alice', 'Bob']).rows
    expect(rows.map((r) => r.approved)).toEqual([null, null])
    expect(participation([known('a', 'ready')], ['Alice', 'Bob']).rows.map((r) => r.approved)).toEqual([1, 0])
  })
})

describe('createProposal refused with seat_required (#575)', () => {
  it('says to unlock this device, not the coordinator’s own sentence', async () => {
    // An unlocked seat 1: the proposer is read from the coordinator's list for that seat (#591).
    setUnlockedShare('v', {
      groupKey: new Uint8Array(32), address: '', roster: [], createdAt: 0,
      sealedShare: new TextEncoder().encode(JSON.stringify({ kp: 'AA==', pubkeys: 'AA==', seat: 1, n: 2, t: 2 })),
    } as never)
    netCreateProposal.mockResolvedValue(null)
    failure.mockReturnValue({ status: 400, code: 'seat_required', error: 'More than one member has this name. Update the app and try again.' })
    const r = await createProposal('v', { proposer: 'Alice', to_address: 'u1x', value_zec: '0.00001' } as never)
    expect(r).toEqual({ ok: false, error: 'seat required' })
  })
})
