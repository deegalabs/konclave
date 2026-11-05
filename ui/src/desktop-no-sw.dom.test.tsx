// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

// The desktop app never registers the web's service worker: a worker left in the WebView profile by
// v0.15.0 opened v0.16.0 to a blank window. The registration lives in <UpdatePrompt /> (useRegisterSW),
// so this renders the real App inside the desktop shell's marker and checks the hook is never called,
// and outside it (the web) that it still is, so the first check cannot pass by never rendering.

const useRegisterSW = vi.hoisted(() => vi.fn(() => ({ needRefresh: [false, () => {}], offlineReady: [false, () => {}], updateServiceWorker: async () => {} })))
vi.mock('virtual:pwa-register/react', () => ({ useRegisterSW }))

// `isDesktop` is read once, when platform.ts loads, so the marker is set before App is imported.
async function renderApp() {
  vi.resetModules()
  const [{ default: App }, { MemoryRouter }, { I18nProvider }, { RevealProvider }, { ToastProvider }] = await Promise.all([
    import('./App'), import('react-router-dom'), import('./i18n'), import('./reveal'), import('./toast'),
  ])
  return render(
    <I18nProvider><RevealProvider><ToastProvider><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></ToastProvider></RevealProvider></I18nProvider>,
  )
}

describe('the desktop app registers no service worker', () => {
  beforeEach(() => {
    useRegisterSW.mockClear()
    // No coordinator or bridge in a unit test: every read fails, the way it does offline.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ })

  it('inside the desktop shell: the app renders and the register hook is never called', async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    const { container } = await renderApp()
    expect(container.querySelector('.root')).toBeTruthy()
    expect(useRegisterSW).not.toHaveBeenCalled()
  })

  it('on the web: the same render calls it (the worker and its update banner stay)', async () => {
    await renderApp()
    expect(useRegisterSW).toHaveBeenCalled()
  })
})
