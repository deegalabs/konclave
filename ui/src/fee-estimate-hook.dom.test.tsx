// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

// The hook itself (#847): ready only when the wasm loaded AND the rule answered; a failed load or a
// rule that cannot answer is `unavailable`, never `ready`.
const w = vi.hoisted(() => ({ load: 'ok' as 'ok' | 'fail', answer: 15_000 }))
vi.mock('./wasm-ready', () => ({ ensureWasm: () => (w.load === 'ok' ? Promise.resolve() : Promise.reject(new Error('no wasm'))) }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ estimatedFeeZat: () => w.answer }))
const { useFeeEstimate, estimatorOf } = await import('./fee-estimate')

describe('useFeeEstimate', () => {
  afterEach(() => cleanup())
  it('starts loading, then is ready with the rule answer', async () => {
    w.load = 'ok'
    w.answer = 15_000
    const { result } = renderHook(() => useFeeEstimate())
    expect(result.current.state).toBe('loading')
    await waitFor(() => expect(result.current.state).toBe('ready'))
    expect(estimatorOf(result.current)?.(1)).toBe(15_000)
  })
  it('a wasm that fails to load is unavailable', async () => {
    w.load = 'fail'
    const { result } = renderHook(() => useFeeEstimate())
    await waitFor(() => expect(result.current.state).toBe('unavailable'))
    expect(estimatorOf(result.current)).toBeNull()
  })
  it('a rule that answers 0 (no clock window) is unavailable', async () => {
    w.load = 'ok'
    w.answer = 0
    const { result } = renderHook(() => useFeeEstimate())
    await waitFor(() => expect(result.current.state).toBe('unavailable'))
  })
})
