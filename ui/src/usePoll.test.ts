import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startVisiblePoll } from './usePoll'

// Core visibility-aware polling (#123), tested without a DOM: a mock document/window captures the
// visibility handler, and fake timers drive the interval.

function mkDoc() {
  const handlers: Record<string, (() => void)[]> = {}
  return {
    hidden: false,
    addEventListener: (t: string, h: () => void) => { (handlers[t] ??= []).push(h) },
    removeEventListener: (t: string, h: () => void) => { handlers[t] = (handlers[t] ?? []).filter((x) => x !== h) },
    fire: (t: string) => (handlers[t] ?? []).forEach((h) => h()),
    count: (t: string) => (handlers[t] ?? []).length,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('startVisiblePoll', () => {
  it('does not call fn on start; fires every interval', () => {
    const fn = vi.fn()
    const doc = mkDoc(); const win = mkDoc()
    const stop = startVisiblePoll(fn, 1000, doc, win)
    expect(fn).toHaveBeenCalledTimes(0) // caller owns the first load
    vi.advanceTimersByTime(3000)
    expect(fn).toHaveBeenCalledTimes(3)
    stop()
  })

  it('pauses while hidden and resumes + refreshes immediately on becoming visible', () => {
    const fn = vi.fn()
    const doc = mkDoc(); const win = mkDoc()
    const stop = startVisiblePoll(fn, 1000, doc, win)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(1)
    // Tab hidden -> visibilitychange -> polling stops.
    doc.hidden = true
    doc.fire('visibilitychange')
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(1) // no ticks while hidden
    // Back to visible -> immediate refresh, then resume.
    doc.hidden = false
    doc.fire('visibilitychange')
    expect(fn).toHaveBeenCalledTimes(2) // immediate on return
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(4) // resumed
    stop()
  })

  it('does not tick while hidden even if the timer somehow fires', () => {
    const fn = vi.fn()
    const doc = mkDoc(); const win = mkDoc()
    doc.hidden = true
    const stop = startVisiblePoll(fn, 1000, doc, win) // starts hidden: no timer armed
    vi.advanceTimersByTime(3000)
    expect(fn).toHaveBeenCalledTimes(0)
    stop()
  })

  it('cleanup removes the listeners and stops the timer', () => {
    const fn = vi.fn()
    const doc = mkDoc(); const win = mkDoc()
    const stop = startVisiblePoll(fn, 1000, doc, win)
    expect(doc.count('visibilitychange')).toBe(1)
    expect(win.count('focus')).toBe(1)
    stop()
    expect(doc.count('visibilitychange')).toBe(0)
    expect(win.count('focus')).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(fn).toHaveBeenCalledTimes(0)
  })
})
