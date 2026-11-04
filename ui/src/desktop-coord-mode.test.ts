import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// #664: desktop members who picked "This device only" while the hosted option was missing from the
// build have 'local' saved. Hiding the button does not reach them: `getCoordMode` returned the saved
// value first, so the whole in-vault app kept calling the local bridge the desktop does not embed
// (#212). This runs with a helper built in, as the fixed desktop release is, and checks the saved
// choice in both shells.
const shell = vi.hoisted(() => {
  vi.stubEnv('VITE_HELPER_BASE', 'https://helper.konclave.xyz')
  return { desktop: true }
})
vi.mock('./platform', () => ({ get isDesktop() { return shell.desktop } }))
const { getCoordMode, helperConfigured, localCoordAvailable, HELPER_BASE } = await import('./helper')

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
afterEach(() => { delete (globalThis as unknown as { localStorage?: Storage }).localStorage })

describe('a saved "local" coordination choice (#664)', () => {
  it('runs with the helper built in', () => {
    expect(HELPER_BASE).toBe('https://helper.konclave.xyz')
  })

  it('on desktop it is ignored, and the built-in helper is used', () => {
    shell.desktop = true
    localStorage.setItem('konclave.coord.mode', 'local')
    expect(getCoordMode()).toBe('ours')
    expect(helperConfigured()).toBe(true)
    expect(localCoordAvailable()).toBe(false)
  })

  it('on desktop a saved custom server is still honoured', () => {
    shell.desktop = true
    localStorage.setItem('konclave.coord.mode', 'custom')
    expect(getCoordMode()).toBe('custom')
  })

  it('on the web it is still honoured, where the local bridge can serve the app', () => {
    shell.desktop = false
    localStorage.setItem('konclave.coord.mode', 'local')
    expect(localCoordAvailable()).toBe(true)
    expect(getCoordMode()).toBe('local')
    expect(helperConfigured()).toBe(false)
  })
})
