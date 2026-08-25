// The queue rules, tested without timers. A repeated action - a second click, a retry after a
// failure - should refresh one row rather than stack three copies of the same sentence, and the
// stack must stay bounded however hard it is driven.
import { describe, expect, it } from 'vitest'
import { DWELL_MS, queueToast } from './toast'

const t = (id: number, kind: 'ok' | 'warn' | 'err' | 'info', message: string) => ({ id, kind, message })

describe('queueToast', () => {
  it('appends in order', () => {
    const s = queueToast(queueToast([], t(1, 'ok', 'a')), t(2, 'ok', 'b'))
    expect(s.map((x) => x.message)).toEqual(['a', 'b'])
  })

  it('replaces an identical message still on screen instead of repeating it', () => {
    const s = queueToast(queueToast([], t(1, 'err', 'could not send')), t(2, 'err', 'could not send'))
    expect(s).toHaveLength(1)
    expect(s[0]!.id).toBe(2) // the new one, so its dwell time starts over
  })

  it('treats the same words in a different kind as a different message', () => {
    const s = queueToast(queueToast([], t(1, 'ok', 'done')), t(2, 'warn', 'done'))
    expect(s).toHaveLength(2)
  })

  it('stays bounded, dropping the oldest', () => {
    let s = [] as ReturnType<typeof t>[]
    for (let i = 1; i <= 6; i++) s = queueToast(s, t(i, 'info', `m${i}`))
    expect(s.map((x) => x.message)).toEqual(['m4', 'm5', 'm6'])
  })
})

describe('DWELL_MS', () => {
  it('gives the reader longer the more the message matters', () => {
    expect(DWELL_MS.err).toBeGreaterThan(DWELL_MS.warn)
    expect(DWELL_MS.warn).toBeGreaterThan(DWELL_MS.ok)
    expect(DWELL_MS.ok).toBe(DWELL_MS.info)
  })
})
