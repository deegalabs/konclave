// @vitest-environment jsdom
// #285, at the hook: the background signer takes its seat's cross-tab lock, says when another tab of
// this browser holds it, takes over when that tab lets go, and leaks nothing when it is stopped while
// the WASM is still loading. Everything around the lock is a stand-in; the lock module is real.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { locks as nodeLocks } from 'node:worker_threads'

const wasm = vi.hoisted(() => ({ gate: Promise.resolve() as Promise<void> }))
vi.mock('./wasm-ready', () => ({ ensureWasm: () => wasm.gate }))
vi.mock('./session', () => ({ getUnlockedShare: () => ({ groupKey: new Uint8Array(32), accessSecret: undefined }) }))
vi.mock('./signing', () => ({ decodeBundle: () => ({ seat: 1, t: 2, keyPackage: new Uint8Array(), groupVk: new Uint8Array(), pubkeys: [] }) }))
vi.mock('./device-key', () => ({ deviceCommsKey: () => new Uint8Array(), devicePubHex: () => '' }))
vi.mock('./net', () => ({
  RelaySession: class { start() {} stop() {} async send() { return true } },
  relayPost: async () => true,
  ephemeralTag: () => 'tag',
}))
vi.mock('./background-session', () => ({
  BackgroundSession: class { setProposal() {} async start() {} async onMessage() {} },
}))

const { useBackgroundSigner } = await import('./useBackgroundSigner')
const use = (id: string) => () => useBackgroundSigner(
  { id }, () => true, () => ({ ok: true }) as never, () => true, async () => {}, () => {},
)

describe('the background signer hook and the cross-tab lock (#285)', () => {
  afterEach(() => { vi.unstubAllGlobals(); wasm.gate = Promise.resolve() })

  it('stopped while the WASM loads, it takes nothing, so the next mount seats', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined })
    let open!: () => void
    wasm.gate = new Promise<void>((r) => { open = r })
    const first = renderHook(use('leak'))
    first.unmount()
    await act(async () => { open(); await new Promise((r) => setTimeout(r, 0)) })
    wasm.gate = Promise.resolve()
    const second = renderHook(use('leak'))
    await waitFor(() => expect(second.result.current.ready).toBe(true))
    expect(second.result.current.error).toBe('')
    second.unmount()
  })

  it('says the seat signs in another tab, and seats when that tab lets go', async () => {
    // Node's own Web Locks implementation, standing in for the browser's.
    const locks = nodeLocks as unknown as LockManager
    vi.stubGlobal('navigator', { ...navigator, locks })
    let letGo!: () => void
    const otherTab = new Promise<void>((r) => { letGo = r })
    void locks.request('konclave-sign-busy-1', {}, () => otherTab)
    await new Promise((r) => setTimeout(r, 10))
    const h = renderHook(use('busy'))
    await waitFor(() => expect(h.result.current.elsewhere).toBe(true))
    expect(h.result.current.ready).toBe(false)
    expect(h.result.current.error).toBe('')
    await act(async () => { letGo(); await new Promise((r) => setTimeout(r, 20)) })
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    expect(h.result.current.elsewhere).toBe(false)
    h.unmount()
    // Unmounted: the lock is free again.
    await new Promise((r) => setTimeout(r, 20))
    const { held } = await locks.query()
    expect(held?.some((l) => l.name === 'konclave-sign-busy-1')).toBe(false)
  })
})
