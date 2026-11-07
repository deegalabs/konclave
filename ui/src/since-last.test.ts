import { describe, expect, it } from 'vitest'
import { changeLabelKey, changesSince, snapshotOf, type Snapshot } from './since-last'
import type { Proposal } from './api'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* "Since last time" (#151, #125): what changed state since this device last looked. A member who
 * opens the app after two days should not read the whole desk to find out what moved: what
 * arrived for them, what became ready, what was sent, confirmed, refused or expired. A local
 * comparison of the proposals' states against a snapshot kept on this device; nothing new on the
 * coordinator. */

const p = (id: string, state: string, over: Partial<Proposal> = {}): Proposal => ({
  id, vault_id: 'v', kind: 'payment', state, proposer: 'ana', value_zat: 1, value_zec: '0.00000001',
  is_public: false, approvals: [], refusals: [], approvals_count: 0, ...over,
})

describe('what changed since the snapshot', () => {
  const before: Snapshot = { a: 'awaiting', b: 'awaiting', c: 'ready', d: 'sent', e: 'awaiting' }
  it('names each kind of change, by the proposal’s new state and whether it needs me', () => {
    const now = [
      p('a', 'ready', { approvals: ['me'] }),            // became ready, and I approved: mine to sign
      p('b', 'rejected'),                                // refused
      p('c', 'sent'),                                    // sent
      p('d', 'confirmed'),                               // confirmed
      p('e', 'expired'),                                 // expired
      p('f', 'awaiting'),                                // new, and I have not voted: arrived for me
      p('g', 'awaiting', { approvals: ['me'] }),         // new, but I already voted: new, not for me
      p('h', 'ready', { approvals: ['bia'] }),           // became ready without my approval: ready, no promise who signs
      p('i', 'cancelled'),                               // withdrawn by its proposer, refused by nobody
    ]
    const before2: Snapshot = { ...before, h: 'awaiting', i: 'awaiting' }
    expect(changesSince(before2, now, 'me')!.map((c) => [c.id, c.kind])).toEqual([
      ['f', 'arrived'], ['a', 'ready'], ['h', 'ready'], ['c', 'sent'], ['d', 'confirmed'], ['b', 'refused'], ['i', 'withdrawn'], ['e', 'expired'], ['g', 'new'],
    ])
  })
  it('says nothing about a proposal whose state did not move', () => {
    expect(changesSince(before, [p('a', 'awaiting'), p('d', 'sent')], 'me')).toEqual([])
  })
  it('with no identity, a new awaiting proposal is new, not "for you", and a ready one is ready', () => {
    expect(changesSince({}, [p('x', 'awaiting')], null)!.map((c) => c.kind)).toEqual(['new'])
    expect(changesSince({ y: 'awaiting' }, [p('y', 'ready', { approvals: ['me'] })], null)!.map((c) => c.kind)).toEqual(['ready'])
  })
  it('a proposal that vanished from the list is not invented as a change', () => {
    expect(changesSince({ gone: 'awaiting' }, [], 'me')).toEqual([])
  })
  it('with no snapshot there is nothing to compare: null, not "everything changed"', () => {
    expect(changesSince(null, [p('a', 'awaiting')], 'me')).toBeNull()
  })
  it('the snapshot is the states by id', () => {
    expect(snapshotOf([p('a', 'ready'), p('b', 'sent')])).toEqual({ a: 'ready', b: 'sent' })
  })
  it('a proposal created and closed between two looks is named by how it ended, not as new', () => {
    expect(changesSince({}, [p('r', 'rejected'), p('s', 'sent'), p('x', 'expired')], 'me')!.map((c) => [c.id, c.kind])).toEqual([
      ['s', 'sent'], ['r', 'refused'], ['x', 'expired'],
    ])
  })
  it('reads the deadline on this device\'s clock: an open proposal past it has expired, like on the desk', () => {
    const past = { expiry_unix: 1_000 }
    expect(changesSince({ a: 'awaiting' }, [p('a', 'awaiting', past)], 'me')!.map((c) => [c.kind, c.to])).toEqual([['expired', 'expired']])
    expect(snapshotOf([p('a', 'ready', past)])).toEqual({ a: 'expired' })
    // and once seen as expired, the coordinator catching up is not a second change
    expect(changesSince({ a: 'expired' }, [p('a', 'expired')], 'me')).toEqual([])
  })
  it('names a change with the words the proposal list already uses for a state', () => {
    const one = (from: string | null, q: Proposal) => changesSince(from === null ? {} : { [q.id]: from }, [q], 'me')![0]!
    expect(changeLabelKey(one(null, p('n', 'awaiting')))).toBe('since.kind.arrived')
    expect(changeLabelKey(one(null, p('n', 'awaiting', { approvals: ['me'] })))).toBe('since.kind.new')
    expect(changeLabelKey(one('awaiting', p('a', 'ready')))).toBe('stamp.ready')
    expect(changeLabelKey(one('awaiting', p('a', 'cancelled')))).toBe('stamp.cancelled')
    expect(changeLabelKey(one('awaiting', p('a', 'awaiting', { expiry_unix: 1_000 })))).toBe('stamp.expired')
  })
})

describe('the tab exists and speaks both languages', () => {
  it('Approvals has the tab and the screen marks what was seen on this device only', () => {
    expect(codeOf('screens/Activity.tsx')).toMatch(/'since'/)
    const src = codeOf('screens/SinceLast.tsx')
    expect(src).toMatch(/t\('since\.markSeen'\)/)
    for (const k of ['activity.tab.since', 'since.title', 'since.firstTime', 'since.nothing', 'since.markSeen', 'since.seenAt', 'since.unreadTitle', 'since.changes', 'since.fromTo',
      'since.kind.arrived', 'since.kind.new']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
    }
    // A state is named with the list's own word (stamp.*), not a second vocabulary.
    for (const k of ['ready', 'readyOthers', 'sent', 'confirmed', 'refused', 'withdrawn', 'expired', 'changed']) {
      expect(en[`since.kind.${k}`], k).toBeUndefined(); expect(ptBR[`since.kind.${k}`], k).toBeUndefined()
    }
  })
})
