import { describe, expect, it, beforeEach, beforeAll } from 'vitest'
import { loadPrfWrap, savePrfWrap, clearPrfWrap } from './prf-store'
import type { PrfWrap } from './prf-wrap'

// vitest runs in node, where there is no `localStorage`. A minimal in-memory one, so these tests
// exercise the real module rather than a version of it written to be testable.
beforeAll(() => {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    },
  })
})

const wrap: PrfWrap = { credentialId: 'AQID', salt: 'aa'.repeat(32), iv: 'bb'.repeat(12), cipher: 'cc'.repeat(48) }

describe('the PRF wrap store (#446 C)', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips per vault, and one vault never sees another', () => {
    savePrfWrap('vault-a', wrap)
    expect(loadPrfWrap('vault-a')).toEqual(wrap)
    expect(loadPrfWrap('vault-b')).toBeNull()
  })

  it('a half-written record reads as none, never as a usable wrap', () => {
    // A wrap missing a field cannot be opened, and returning it would send the caller into an
    // authenticator prompt that can only fail. Absent is the honest answer.
    localStorage.setItem('konclave.prf.vault-a', JSON.stringify({ credentialId: 'AQID', salt: 'aa' }))
    expect(loadPrfWrap('vault-a')).toBeNull()
  })

  it('garbage reads as none rather than throwing', () => {
    localStorage.setItem('konclave.prf.vault-a', 'not json')
    expect(loadPrfWrap('vault-a')).toBeNull()
  })

  it('clearing removes it', () => {
    savePrfWrap('vault-a', wrap)
    clearPrfWrap('vault-a')
    expect(loadPrfWrap('vault-a')).toBeNull()
  })

  it('storage being unavailable is silent on every path', () => {
    // Private mode and blocked site data throw on access. A shortcut that cannot be stored is not
    // an error the member should ever see.
    const real = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked') },
    })
    expect(() => savePrfWrap('v', wrap)).not.toThrow()
    expect(loadPrfWrap('v')).toBeNull()
    expect(() => clearPrfWrap('v')).not.toThrow()
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: real })
  })
})
