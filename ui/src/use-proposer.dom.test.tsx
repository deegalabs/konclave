// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

// #591: how the proposing screens keep asking who they propose as. While it cannot say they ask
// again; never two requests at once; never once there is a name; slowly for a seat with no name.
const answers = vi.hoisted(() => ({ next: [] as (() => Promise<unknown>)[], calls: 0 }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  actingAs: () => { answers.calls++; return (answers.next.shift() ?? (() => Promise.resolve({ ok: false, why: 'locked' })))() },
}))
const { useProposer, ASK_EVERY_MS, ASK_NAMELESS_EVERY_MS } = await import('./use-proposer')
const vault = { id: 'v' }
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const ok = () => Promise.resolve({ ok: true, seat: 2, name: 'Bia' })
const nameless = () => Promise.resolve({ ok: false, why: 'no-seat-name' })

describe('useProposer asks again, within limits (#591)', () => {
  beforeEach(() => { vi.useFakeTimers(); answers.calls = 0; answers.next = [] })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('asks once on mount, then again every interval while it cannot say', async () => {
    renderHook(() => useProposer(vault))
    await tick(0)
    expect(answers.calls).toBe(1)
    await tick(ASK_EVERY_MS * 3)
    expect(answers.calls).toBe(4)
  })

  it('stops asking once it has a name, and shows it', async () => {
    answers.next = [() => Promise.resolve({ ok: false, why: 'locked' }), ok]
    const { result } = renderHook(() => useProposer(vault))
    await tick(0)
    expect(result.current.name).toBeNull()
    await tick(ASK_EVERY_MS)
    expect(result.current.name).toBe('Bia')
    const seen = answers.calls
    await tick(ASK_EVERY_MS * 10)
    expect(answers.calls).toBe(seen)
  })

  it('never starts a second request while one is in flight', async () => {
    let release: (v: unknown) => void = () => {}
    answers.next = [() => new Promise((r) => { release = r })]
    renderHook(() => useProposer(vault))
    await tick(ASK_EVERY_MS * 4)
    expect(answers.calls).toBe(1)
    release({ ok: false, why: 'locked' })
    await tick(ASK_EVERY_MS)
    expect(answers.calls).toBe(2)
  })

  it('a seat with no name is asked for on the slow cadence, not every few seconds', async () => {
    answers.next = [nameless, nameless, nameless, nameless]
    renderHook(() => useProposer(vault))
    await tick(0)
    await tick(ASK_EVERY_MS) // the first poll tick is still on the fast timer: one more answer, then slow
    const afterSwitch = answers.calls
    await tick(ASK_NAMELESS_EVERY_MS - ASK_EVERY_MS - 1)
    expect(answers.calls).toBe(afterSwitch)
    await tick(ASK_NAMELESS_EVERY_MS)
    expect(answers.calls).toBeGreaterThan(afterSwitch)
  })

  it('refresh asks at once', async () => {
    const { result } = renderHook(() => useProposer(vault))
    await tick(0)
    const before = answers.calls
    answers.next = [ok]
    await act(async () => { result.current.refresh() })
    await tick(0)
    expect(answers.calls).toBe(before + 1)
    expect(result.current.name).toBe('Bia')
  })
})
