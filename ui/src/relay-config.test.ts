import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRelayMode, getCustomRelay, setRelay, relayBase, RELAY_BASE } from './net'

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
})
