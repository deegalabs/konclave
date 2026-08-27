// #280: the one defect that can tell a treasurer money did not move when it did.
import { describe, expect, it, vi } from 'vitest'
import { readOutcome, resolveOutcome, canRetry, type SentProbe } from './send-outcome'

const P = (o: Partial<SentProbe> & { id: string }): SentProbe => ({ state: 'ready', ...o })
const nowait = () => Promise.resolve()

describe('readOutcome', () => {
  it('reports sent when the proposal carries a txid', () => {
    expect(readOutcome([P({ id: 'a', state: 'sent', txid: 'deadbeef' })], 'a'))
      .toEqual({ kind: 'sent', txid: 'deadbeef' })
  })

  it('reports not-sent only when the vault answered and the proposal is still open', () => {
    expect(readOutcome([P({ id: 'a', state: 'ready' })], 'a')).toEqual({ kind: 'not-sent' })
    expect(readOutcome([P({ id: 'a', state: 'awaiting' })], 'a')).toEqual({ kind: 'not-sent' })
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
      .mockResolvedValueOnce([P({ id: 'a', state: 'ready' })])
    const r = await resolveOutcome('a', { list, wait: nowait }, 5, 0)
    expect(r).toEqual({ kind: 'not-sent' })
    expect(list).toHaveBeenCalledTimes(2)
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

describe('canRetry - the gate that prevents a double spend', () => {
  it('allows retry only when we know nothing moved', () => {
    expect(canRetry({ kind: 'not-sent' })).toBe(true)
    expect(canRetry({ kind: 'failed', error: 'insufficient funds' })).toBe(true)
  })

  it('BUG #280: never offers retry while the outcome is unknown', () => {
    // Retrying here is an attempt to spend the same notes twice.
    expect(canRetry({ kind: 'unknown' })).toBe(false)
    expect(canRetry({ kind: 'unresolved' })).toBe(false)
    expect(canRetry({ kind: 'sent', txid: 'abc' })).toBe(false)
    expect(canRetry(null)).toBe(false)
  })
})
