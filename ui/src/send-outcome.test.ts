// #280: the one defect that can tell a treasurer money did not move when it did.
import { describe, expect, it, vi } from 'vitest'
import { OutcomeBook, peerFailureMayShow, readOutcome, readReply, resolveOutcome, sentTxidOf, type SendReply, type SentProbe } from './send-outcome'

const P = (o: Partial<SentProbe> & { id: string }): SentProbe => ({ state: 'ready', ...o })
const nowait = () => Promise.resolve()

describe('readOutcome', () => {
  it('reports sent when the proposal carries a txid', () => {
    expect(readOutcome([P({ id: 'a', state: 'sent', txid: 'deadbeef' })], 'a'))
      .toEqual({ kind: 'sent', txid: 'deadbeef' })
  })

  it('never reads "not sent" from a record with no txid', () => {
    // After a lost reply, a record with no txid cannot say "nothing went out".
    for (const state of ['ready', 'awaiting', 'pending', 'expired', 'refused']) {
      expect(readOutcome([P({ id: 'a', state })], 'a'), state).toBeNull()
    }
  })

  it('BUG #280: an unreachable vault is NOT evidence that nothing was sent', () => {
    // Collapsing "could not ask" into "did not happen" is the whole defect. `null` in, `null` out.
    expect(readOutcome(null, 'a')).toBeNull()
  })

  it('does not decide from a proposal the vault does not know', () => {
    expect(readOutcome([P({ id: 'other' })], 'a')).toBeNull()
  })

  it('treats sent-without-txid as undecided, not as sent', () => {
    // A half-written record. Claiming a send with nothing to verify is the same sin in reverse.
    expect(readOutcome([P({ id: 'a', state: 'sent', txid: null })], 'a')).toBeNull()
    expect(readOutcome([P({ id: 'a', state: 'sent', txid: '  ' })], 'a')).toBeNull()
  })
})

describe('resolveOutcome', () => {
  it('stops at the first definite answer', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([P({ id: 'a', state: 'sent', txid: 'ab' })])
    const r = await resolveOutcome('a', { list, wait: nowait }, 5, 0)
    expect(r).toEqual({ kind: 'sent', txid: 'ab' })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('a record still ready with no txid ends unresolved, never not-sent', async () => {
    const list = vi.fn().mockResolvedValue([P({ id: 'a', state: 'ready' })])
    expect(await resolveOutcome('a', { list, wait: nowait }, 3, 0)).toEqual({ kind: 'unresolved' })
  })

  it('finds a txid that only appears on a later attempt', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([P({ id: 'a', state: 'sent', txid: 'abc123' })])
    expect(await resolveOutcome('a', { list, wait: nowait }, 5, 0)).toEqual({ kind: 'sent', txid: 'abc123' })
  })

  it('says unresolved rather than inventing a failure when the window closes', async () => {
    const list = vi.fn().mockResolvedValue(null)
    expect(await resolveOutcome('a', { list, wait: nowait }, 3, 0)).toEqual({ kind: 'unresolved' })
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('counts down honestly for the UI', async () => {
    const seen: number[] = []
    const list = vi.fn().mockResolvedValue(null)
    await resolveOutcome('a', { list, wait: nowait, onAttempt: (n) => seen.push(n) }, 3, 0)
    expect(seen).toEqual([3, 2, 1])
  })

  it('does not sleep after the final attempt', async () => {
    const wait = vi.fn().mockResolvedValue(undefined)
    await resolveOutcome('a', { list: async () => null, wait }, 3, 1000)
    expect(wait).toHaveBeenCalledTimes(2)
  })
})

// How the panel ends a send from what the coordinator answered (#626, the coordinator's send
// record). Only `not-sent` withdraws the signatures and offers Try again, so it must never come
// from an answer that says the money may have moved.
describe('readReply', () => {
  const HELD = 'not sent yet: may be on the network'
  const MAYBE = 'may be on the network'
  const NOT_RECORDED = 'nothing was sent'

  it('a refusal while the payment still reads ready may be on the network', () => {
    expect(readReply({ error: HELD, state: 'ready' })).toEqual({ kind: 'held' })
  })

  it('an error with a txid is unknown', () => {
    expect(readReply({ error: MAYBE, txid: 'f00d' })).toEqual({ kind: 'held', txid: 'f00d' })
  })

  it('no answer that carries a txid ends as not sent, whatever else it says', () => {
    for (const r of [{ error: 'x', txid: 'f00d' }, { error: 'x', state: 'refused', txid: 'f00d' }, { error: 'x', state: 'expired', txid: 'f00d' }] as SendReply[]) {
      expect(readReply(r).kind, JSON.stringify(r)).not.toBe('not-sent')
    }
  })

  it('an error with a reason and no txid or state went nowhere', () => {
    expect(readReply({ error: NOT_RECORDED })).toEqual({ kind: 'not-sent', why: 'error', raw: NOT_RECORDED })
  })

  it('a payment that is no longer sendable names its state; one another device sent is read from the record', () => {
    expect(readReply({ error: 'proposal is not ready to send', state: 'expired' })).toEqual({ kind: 'not-sent', why: 'not-sendable', state: 'expired', raw: 'proposal is not ready to send' })
    expect(readReply({ error: 'proposal is not ready to send', state: 'sent' })).toEqual({ kind: 'resolve', sentElsewhere: true })
    expect(readReply({ unknown: true })).toEqual({ kind: 'resolve' })
  })

  it('a reply with a txid is a send; one without is not', () => {
    expect(readReply({ txid: 'ab', dry_run: false, state: 'sent' })).toEqual({ kind: 'sent', txid: 'ab' })
    expect(readReply({ txid: null, dry_run: false, state: 'sent' })).toEqual({ kind: 'not-sent', why: 'no-txid' })
    expect(readReply(null)).toEqual({ kind: 'not-sent', why: 'unreachable' })
  })
})

// What the panel shows as sent: a broadcast that came back with an error carries a
// txid too, and reading "has a txid" as "sent" showed it as paid, with the explorer link, and stopped
// the watch.
describe('sentTxidOf', () => {
  it('a sent result is sent; an unknown one with a txid to look for is not', () => {
    expect(sentTxidOf({ txid: 'ab' })).toBe('ab')
    expect(sentTxidOf({ unresolved: 'broadcast', txid: 'ab' })).toBeNull()
    expect(sentTxidOf({ unresolved: 'held' })).toBeNull()
    expect(sentTxidOf({ error: 'x' })).toBeNull()
    expect(sentTxidOf({ txid: null })).toBeNull()
    expect(sentTxidOf(null)).toBeNull()
  })
})

// A send's outcome belongs to its payment: one that lands while another payment is
// open is kept, and shown when its payment opens again, so a "may have gone out" is never lost.
describe('OutcomeBook', () => {
  it('shows an outcome only on its own payment, and keeps it for when that payment opens again', () => {
    const b = new OutcomeBook()
    expect(b.record('p1', { unresolved: 'broadcast', txid: 'f00d' }, 'p2')).toBe(false)
    expect(b.restore('p2')).toBeNull()
    expect(b.restore('p1')).toEqual({ unresolved: 'broadcast', txid: 'f00d' })
    expect(b.record('p1', { txid: 'ab' }, 'p1')).toBe(true)
    expect(b.restore('p1')).toEqual({ txid: 'ab' })
  })
  it('clearing one payment\'s outcome leaves the others', () => {
    const b = new OutcomeBook()
    b.record('p1', { error: 'x' }, 'p1')
    b.record('p2', { unresolved: 'held' }, 'p1')
    b.clear('p1')
    expect(b.restore('p1')).toBeNull()
    expect(b.restore('p2')).toEqual({ unresolved: 'held' })
  })
})

// What another device's failure may replace on this screen: never a payment that may be on the
// network or one shown as sent.
describe('peerFailureMayShow', () => {
  it('replaces nothing that says the money may have moved', () => {
    expect(peerFailureMayShow({ unresolved: 'lost' })).toBe(false)
    expect(peerFailureMayShow({ unresolved: 'held' })).toBe(false)
    expect(peerFailureMayShow({ txid: 'ab' })).toBe(false)
    expect(peerFailureMayShow(null)).toBe(true)
    expect(peerFailureMayShow({ error: 'x' })).toBe(true)
  })
})
