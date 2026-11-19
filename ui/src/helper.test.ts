import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  helperConfigured,
  helperHealth,
  registerVaultResult,
  getVault,
  HELPER_BASE,
  getCoordMode,
  setCoordMode,
  getCustomHelper,
  helperBase,
} from './helper'

// These tests run with VITE_HELPER_BASE unset (the default), so HELPER_BASE is ''. That is the
// local-first contract: with no hosted helper configured, `/net` stays a pure device-to-device
// ceremony - every helper call must degrade to null WITHOUT ever touching the network.

// The suite runs in node (no DOM). helper.ts guards localStorage access with try/catch, but the
// coordination-mode tests need a real store to exercise persistence, so install a fresh in-memory
// one before each test - which also isolates every test from the others.
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

describe('local-first degradation (no VITE_HELPER_BASE)', () => {
  it('reports no helper configured', () => {
    expect(HELPER_BASE).toBe('')
    expect(helperConfigured()).toBe(false)
  })

  it('never calls fetch and resolves everything to null', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    expect(await helperHealth()).toBeNull()
    expect(await registerVaultResult('deadbeef', 'v', 0, 0, 2)).toEqual({ failure: null })
    expect(await getVault('deadbeef')).toBeNull()
    // The whole point: no network egress when the helper is not configured.
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('coordination mode (runtime choice)', () => {
  it('defaults to local when no helper is baked in', () => {
    expect(getCoordMode()).toBe('local')
    expect(helperBase()).toBe('')
    expect(helperConfigured()).toBe(false)
  })

  it('ignores an unknown persisted mode and falls back to the default', () => {
    localStorage.setItem('konclave.coord.mode', 'bogus')
    expect(getCoordMode()).toBe('local')
  })

  it('custom mode uses the user URL and trims trailing slashes', () => {
    setCoordMode('custom', 'https://my-helper.example.com//')
    expect(getCoordMode()).toBe('custom')
    expect(getCustomHelper()).toBe('https://my-helper.example.com')
    expect(helperBase()).toBe('https://my-helper.example.com')
    expect(helperConfigured()).toBe(true)
  })

  // #1067: a blank address is refused like any other invalid one, so nothing is stored and the mode
  // stays where it was (here the default). It used to store 'custom' with an empty address; no screen
  // can send a blank one (the button is disabled), so only this test saw the difference.
  it('custom mode with a blank URL is refused and stores nothing', () => {
    expect(setCoordMode('custom', '   ')).toBe('empty')
    expect(localStorage.getItem('konclave.coord.mode')).toBeNull()
    expect(localStorage.getItem('konclave.coord.url')).toBeNull()
    expect(getCustomHelper()).toBe('')
    expect(helperBase()).toBe('')
    expect(helperConfigured()).toBe(false)
  })

  it('switching to local drops the helper even after a custom URL was set', () => {
    setCoordMode('custom', 'https://x.example')
    setCoordMode('local')
    expect(getCoordMode()).toBe('local')
    expect(helperBase()).toBe('')
    expect(helperConfigured()).toBe(false)
  })

  it.each([
    ['credentials', 'https://user:pass@x.example'],
    ['query', 'https://x.example/?token=1'],
    ['fragment', 'https://x.example#f'],
    ['insecure', 'http://x.example'],
  ])('refuses an address with %s and stores nothing, not even the mode (#1067)', (reason, url) => {
    expect(setCoordMode('custom', url)).toBe(reason)
    expect(localStorage.getItem('konclave.coord.mode')).toBeNull()
    expect(localStorage.getItem('konclave.coord.url')).toBeNull()
    expect(getCoordMode()).toBe('local')
  })

  it('a valid address is stored normalised, and the setter says nothing went wrong (#1067)', () => {
    expect(setCoordMode('custom', 'HTTPS://X.Example/')).toBeNull()
    expect(localStorage.getItem('konclave.coord.url')).toBe('https://x.example')
  })

  // An address stored before #1067 (or written by hand) is read through the same rule: a refused one
  // never reaches a request URL, however it got there.
  it('a stored address the rule refuses is never put in a request (#1067)', async () => {
    localStorage.setItem('konclave.coord.mode', 'custom')
    localStorage.setItem('konclave.coord.url', 'https://user:secret@x.example')
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(helperBase()).not.toContain('secret')
    await helperHealth()
    for (const [u] of spy.mock.calls) expect(String(u)).not.toContain('secret')
  })

  it('picking a mode removes a stored address the rule refuses (#1067)', () => {
    localStorage.setItem('konclave.coord.url', 'https://user:secret@x.example')
    setCoordMode('ours')
    expect(localStorage.getItem('konclave.coord.url')).toBeNull()
  })

  it('picking a mode keeps a stored address the rule takes (#1067)', () => {
    localStorage.setItem('konclave.coord.url', 'https://x.example')
    setCoordMode('ours')
    expect(localStorage.getItem('konclave.coord.url')).toBe('https://x.example')
  })

  it('a configured custom helper still degrades to null on a network failure (no throw)', async () => {
    setCoordMode('custom', 'https://unreachable.invalid')
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await helperHealth()).toBeNull()
    // It DID attempt the call (helper is configured), but the failure degraded cleanly.
    expect(spy).toHaveBeenCalledOnce()
  })
})
