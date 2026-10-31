import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WALLET_BUSY } from './helper'
import { HISTORY_RETRY_MS, historyReader } from './useVaultBalance'
import { codeOf } from './source-scan'

// How Add funds reads the vault's history (Daniel, 16/10; code audit and tester of 6b1744f). One read
// at a time; a failed read is retried soon but on a short, growing schedule that stops, and never
// from a hidden tab; stopping the reader ends everything it scheduled. These run the reader itself
// on fake timers, so a change in behaviour shows up here and not only as different source text.

type Read = Awaited<ReturnType<Parameters<typeof historyReader>[0]['read']>>

function harness(answers: Read[], hidden = () => false) {
  const reads: number[] = []
  const results: Read[] = []
  let starts = 0
  const queue = [...answers]
  const reader = historyReader({
    read: () => {
      reads.push(Date.now())
      return Promise.resolve(queue.length ? queue.shift()! : [])
    },
    onStart: () => { starts++ },
    onResult: (r) => { results.push(r) },
    hidden,
  })
  return { reader, reads, results, starts: () => starts }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('the history reader', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
  afterEach(() => { vi.useRealTimers() })

  it('retries a failed read on a growing schedule, and stops after the last step', async () => {
    const h = harness([null, null, null, null, null])
    h.reader.tick()
    await flush()
    for (const ms of HISTORY_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(ms)
    }
    expect(h.reads).toEqual([0, 3_000, 9_000, 21_000])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads.length).toBe(4) // no fifth read without a poll tick
  })

  it('an answer ends the retries and resets the schedule', async () => {
    const h = harness([null, [], null])
    h.reader.tick()
    await flush()
    await vi.advanceTimersByTimeAsync(3_000) // retry answers
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toEqual([0, 3_000])
    h.reader.tick() // the next poll fails again: the schedule starts over at its first step
    await flush()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.reads).toEqual([0, 3_000, 63_000, 66_000])
  })

  it('a busy coordinator is not retried early: the poll comes back to it', async () => {
    const h = harness([WALLET_BUSY])
    h.reader.tick()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toEqual([0])
  })

  it('does not retry from a hidden tab', async () => {
    const h = harness([null], () => true)
    h.reader.tick()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toEqual([0])
  })

  it('reads one at a time: a tick during a read starts nothing', async () => {
    let release: (r: Read) => void = () => {}
    const reads: number[] = []
    const reader = historyReader({
      read: () => { reads.push(Date.now()); return new Promise<Read>((res) => { release = res }) },
      onStart: () => {},
      onResult: () => {},
      hidden: () => false,
    })
    reader.tick()
    reader.tick()
    expect(reads.length).toBe(1)
    release([])
    await flush()
    reader.tick()
    expect(reads.length).toBe(2)
  })

  it('a poll tick replaces a pending retry instead of adding a second one', async () => {
    const h = harness([null, [], []])
    h.reader.tick()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    h.reader.tick() // the poll arrives before the 3 s retry
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.reads).toEqual([0, 1_000])
  })

  it('stop ends everything: no retry fires and no result arrives after it', async () => {
    let release: (r: Read) => void = () => {}
    const results: Read[] = []
    const reads: number[] = []
    const reader = historyReader({
      read: () => { reads.push(Date.now()); return new Promise<Read>((res) => { release = res }) },
      onStart: () => {},
      onResult: (r) => { results.push(r) },
      hidden: () => false,
    })
    reader.tick()
    reader.stop()
    release(null)
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(results).toEqual([])
    expect(reads.length).toBe(1)
    reader.tick()
    expect(reads.length).toBe(1)
  })

  it('reports each read start and each result, in order', async () => {
    const h = harness([null, []])
    h.reader.tick()
    await flush()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.starts()).toBe(2)
    expect(h.results).toEqual([null, []])
  })
})

describe('Add funds reads through the reader, and not behind the unlock overlay', () => {
  const receive = codeOf('./screens/Receive.tsx')

  it('waits for the vault to be unlocked, and reads again the moment it is', () => {
    // The shared hook asks `needsUnlock` before the first read; the overlay's `locked` alone landed late.
    expect(receive).toMatch(/const readable = useVaultReadable\(\)/)
    expect(receive).toMatch(/if \(!readable\) return\s*let on = true\s*const reader = historyReader<WalletTx>\(/)
    expect(receive).toMatch(/\}, \[readable\]\)/)
  })

  it('has no read schedule of its own', () => {
    // Its only timer is the copy confirmation; no retry timer and no in-flight flag of its own.
    expect(receive.match(/setTimeout\(/g)).toEqual(['setTimeout('])
    expect(receive).toMatch(/setTimeout\(\(\) => setCopied\(null\), 1600\)/)
    expect(receive).not.toMatch(/inFlight|retry/)
    expect(receive).toMatch(/const stop = startVisiblePoll\(reader\.tick, 15_000\)/)
    expect(receive).toMatch(/reader\.stop\(\)/)
  })
})
