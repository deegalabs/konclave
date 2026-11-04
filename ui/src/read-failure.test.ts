import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyRead, lastReadFailure, recordRead } from './read-failure'

// #320: a read that fails says why. Every read used to collapse to "nothing",
// so a screen could not tell "empty" from "could not read", nor "no network" from "access denied".
// The reason is recorded per path, next to the read, and a screen asks for it after the read.

describe('why a read failed', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('names the reason from the error or the answer', () => {
    expect(classifyRead({ error: new DOMException('aborted', 'AbortError') })).toBe('timeout')
    vi.stubGlobal('navigator', { onLine: false })
    expect(classifyRead({ error: new TypeError('Failed to fetch') })).toBe('offline')
    vi.stubGlobal('navigator', { onLine: true })
    expect(classifyRead({ error: new TypeError('Failed to fetch') })).toBe('unavailable')
    expect(classifyRead({ status: 401 })).toBe('denied')
    expect(classifyRead({ status: 403 })).toBe('denied')
    expect(classifyRead({ status: 404 })).toBe('missing')
    expect(classifyRead({ status: 503 })).toBe('unavailable')
    expect(classifyRead({ error: new SyntaxError('Unexpected token') })).toBe('malformed')
  })

  it('remembers the reason per path, without the query string, until the next read of it', () => {
    recordRead('/api/ledger?vault=abc', 'denied', 'coordinator')
    expect(lastReadFailure('/api/ledger')).toEqual({ reason: 'denied', source: 'coordinator' })
    expect(lastReadFailure('/api/vault')).toBeNull()
    recordRead('/api/ledger?vault=abc', null)
    expect(lastReadFailure('/api/ledger')).toBeNull()
  })

  it('the bridge read records it: a refused answer leaves "denied" behind the null it returns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    const { health } = await import('./api')
    expect(await health()).toBe(false)
    expect(lastReadFailure('/api/health')).toEqual({ reason: 'denied', source: 'bridge' }) // the bridge was asked, and says so
  })
})
