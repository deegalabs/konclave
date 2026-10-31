import { describe, expect, it } from 'vitest'
import { changesSince, snapshotOf, type Snapshot } from './since-last'
import type { Proposal } from './api'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* "Since last time" (#151, #125): what changed state since this device last looked. A member who
 * opens the app after two days should not read the whole desk to find out what moved: what
 * arrived for them, what became ready, what was sent, confirmed, refused or expired. A local
 * comparison of the proposals' states against a snapshot kept on this device; nothing new on the
 * coordinator. A milestone that passed waits for the commitment field. */

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
      p('h', 'ready', { approvals: ['bia'] }),           // became ready without my approval: others sign
      p('i', 'cancelled'),                               // withdrawn by its proposer, refused by nobody
    ]
    const before2: Snapshot = { ...before, h: 'awaiting', i: 'awaiting' }
    expect(changesSince(before2, now, 'me')!.map((c) => [c.id, c.kind])).toEqual([
      ['f', 'arrived'], ['a', 'ready'], ['h', 'readyOthers'], ['c', 'sent'], ['d', 'confirmed'], ['b', 'refused'], ['i', 'withdrawn'], ['e', 'expired'], ['g', 'new'],
    ])
  })
  it('says nothing about a proposal whose state did not move', () => {
    expect(changesSince(before, [p('a', 'awaiting'), p('d', 'sent')], 'me')).toEqual([])
  })
  it('with no identity, a new awaiting proposal is new, not "for you", and a ready one is for others', () => {
    expect(changesSince({}, [p('x', 'awaiting')], null)!.map((c) => c.kind)).toEqual(['new'])
    expect(changesSince({ y: 'awaiting' }, [p('y', 'ready', { approvals: ['me'] })], null)!.map((c) => c.kind)).toEqual(['readyOthers'])
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
})

describe('the tab exists and speaks both languages', () => {
  it('Approvals has the tab and the screen marks what was seen on this device only', () => {
    expect(codeOf('screens/Activity.tsx')).toMatch(/'since'/)
    const src = codeOf('screens/SinceLast.tsx')
    expect(src).toMatch(/localStorage/)
    expect(src).toMatch(/t\('since\.markSeen'\)/)
    // the row is a button inside a list item, so the list keeps its count and the row its name
    expect(src).toMatch(/<li[^>]*>\s*<button/)
    expect(src).not.toMatch(/<li role="button"/)
    for (const k of ['activity.tab.since', 'since.title', 'since.firstTime', 'since.nothing', 'since.markSeen', 'since.seenAt', 'since.unreadTitle', 'since.changes', 'since.fromTo',
      'since.kind.arrived', 'since.kind.new', 'since.kind.ready', 'since.kind.readyOthers', 'since.kind.sent', 'since.kind.confirmed', 'since.kind.refused', 'since.kind.withdrawn', 'since.kind.expired', 'since.kind.changed']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
    }
  })
})
