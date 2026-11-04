/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { retireServiceWorkers, WORKBOX_CACHE } from './desktop-worker'
import { codeOf } from './source-scan'

// The desktop app opened to a blank window after the v0.16.0 installer replaced v0.15.0: the WebView
// profile survived the upgrade and so did the service worker v0.15.0 had registered in it. Moving the
// profile aside fixed it. These pin both halves of the fix and the one boundary it must not cross.

function fakeWorkers(n: number, ok = true) {
  const regs = Array.from({ length: n }, () => ({ unregister: vi.fn(async () => ok) }))
  return { regs, sw: { getRegistrations: vi.fn(async () => regs) } }
}

function fakeCaches(names: string[]) {
  const left = new Set(names)
  return { left, caches: { keys: vi.fn(async () => [...left]), delete: vi.fn(async (n: string) => left.delete(n)) } }
}

describe('retireServiceWorkers removes what an earlier version left in the profile', () => {
  it('unregisters every worker and deletes the workbox caches, and only those', async () => {
    const { regs, sw } = fakeWorkers(2)
    const { left, caches } = fakeCaches(['workbox-precache-v2-http://tauri.localhost/', 'workbox-runtime', 'someone-else'])
    const out = await retireServiceWorkers(sw, caches)
    expect(regs.every((r) => r.unregister.mock.calls.length === 1)).toBe(true)
    expect(out.unregistered).toBe(2)
    expect(out.cachesDeleted.sort()).toEqual(['workbox-precache-v2-http://tauri.localhost/', 'workbox-runtime'])
    expect([...left]).toEqual(['someone-else'])
  })

  it('has nothing to do in a webview with no service workers or CacheStorage, and does not throw', async () => {
    await expect(retireServiceWorkers(undefined, undefined)).resolves.toEqual({ unregistered: 0, cachesDeleted: [] })
  })

  it('a failure never stops the app opening: it is logged locally and the caches are still cleared', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sw = { getRegistrations: vi.fn(async () => { throw new Error('denied') }) }
    const { caches } = fakeCaches(['workbox-precache-v2-x'])
    await expect(retireServiceWorkers(sw, caches)).resolves.toEqual({ unregistered: 0, cachesDeleted: ['workbox-precache-v2-x'] })
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('the cache rule matches the workbox names and nothing else', () => {
    expect(WORKBOX_CACHE.test('workbox-precache-v2-https://www.konclave.xyz/')).toBe(true)
    expect(WORKBOX_CACHE.test('konclave-workbox')).toBe(false)
  })
})

describe('the fix touches no record a member keeps', () => {
  it('desktop-worker.ts never names IndexedDB or localStorage (the share and the read secret live there)', () => {
    const src = codeOf('desktop-worker.ts')
    expect(src).not.toMatch(/indexedDB|localStorage|sessionStorage|clear_all_browsing_data/i)
  })
})

describe('both halves are wired, in the places that run (one rule, one flag)', () => {
  it('main.tsx retires the workers on desktop only', () => {
    expect(codeOf('main.tsx')).toMatch(/if \(isDesktop\) void retireServiceWorkers\(\)/)
  })

  it('App renders the update banner (the web worker registration) only off the desktop', () => {
    const app = codeOf('App.tsx')
    expect(app).toMatch(/\{!isDesktop && <UpdatePrompt \/>\}/)
    expect(app.match(/<UpdatePrompt/g)).toHaveLength(1)
  })

  it('the build makes the worker self-destroying exactly when KONCLAVE_DESKTOP_BUILD is "1"', () => {
    const vite = codeOf('../vite.config.ts')
    expect(vite).toMatch(/const desktopBuild = process\.env\.KONCLAVE_DESKTOP_BUILD === '1'/)
    expect(vite).toMatch(/selfDestroying: desktopBuild,/)
  })

  it('desktop-release.yml builds the UI with that flag, on the step that builds it', () => {
    const yml = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')
    const step = yml.split(/\n(?=\s+- name: )/).find((s) => /- name: Build UI\b/.test(s))
    expect(step, 'the Build UI step').toBeTruthy()
    expect(step).toMatch(/KONCLAVE_DESKTOP_BUILD: '1'/)
    expect(step).toMatch(/run: pnpm -C ui run build/)
  })
})
