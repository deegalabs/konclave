import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRelayMode, getCustomRelay, setRelay, relayBase, relayPoll, RELAY_BASE } from './net'

// Relay selection (#213): the user's runtime choice of WHICH blind relay to use. The default is the
// built-in RELAY_BASE, so behavior is unchanged until a relay is actively picked; 'custom' points at
// a self-hosted relay. The suite runs in node (no DOM); net.ts guards localStorage with try/catch,
// so install a fresh in-memory store per test to exercise persistence and isolate the tests.
beforeEach(() => {
  const m = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage
})

describe('relay selection', () => {
  it('defaults to the built-in relay ("ours") with no stored choice', () => {
    expect(getRelayMode()).toBe('ours')
    expect(relayBase()).toBe(RELAY_BASE)
  })

  it('persists and applies a self-hosted relay', () => {
    setRelay('custom', 'https://relay.example.org/')
    expect(getRelayMode()).toBe('custom')
    expect(getCustomRelay()).toBe('https://relay.example.org') // trailing slash trimmed
    expect(relayBase()).toBe('https://relay.example.org')
  })

  it('falls back to the built-in relay when custom is selected but no URL is set', () => {
    setRelay('custom')
    expect(getRelayMode()).toBe('custom')
    expect(relayBase()).toBe(RELAY_BASE)
  })

  it('switching back to the built-in relay restores the default base', () => {
    setRelay('custom', 'https://relay.example.org')
    setRelay('ours')
    expect(getRelayMode()).toBe('ours')
    expect(relayBase()).toBe(RELAY_BASE)
  })

  it.each([
    ['credentials', 'https://user:pass@relay.example.org'],
    ['query', 'https://relay.example.org/?a=1'],
    ['fragment', 'https://relay.example.org#f'],
    ['character', 'https://relay.exa\tmple.org'],
  ])('refuses an address with %s and stores nothing, not even the mode (#1067)', (reason, url) => {
    expect(setRelay('custom', url)).toBe(reason)
    expect(localStorage.getItem('konclave.relay.mode')).toBeNull()
    expect(localStorage.getItem('konclave.relay.url')).toBeNull()
    expect(getRelayMode()).toBe('ours')
  })

  // The relay base also leaves the device: the send hands it to the coordinator (`relay_base`).
  it('a stored relay address the rule refuses is never put in a request (#1067)', async () => {
    localStorage.setItem('konclave.relay.mode', 'custom')
    localStorage.setItem('konclave.relay.url', 'https://user:secret@relay.example.org')
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(relayBase()).not.toContain('secret')
    await relayPoll('room', 0, 'me')
    for (const [u] of spy.mock.calls) expect(String(u)).not.toContain('secret')
  })
})
