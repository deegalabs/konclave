// The desktop app (Tauri) serves its bundle from its own origin, http://tauri.localhost on Windows,
// and has no address bar. The notice must show nothing there. This file uses the app's REAL desktop
// detection (platform.ts reads __TAURI_INTERNALS__ when it loads), so it stubs that marker before
// the modules load, which is why the imports are dynamic.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
const { HostNotice } = await import('./HostNotice')
const { I18nProvider } = await import('./i18n')
const render = (host: string) => renderToStaticMarkup(<I18nProvider><HostNotice host={host} /></I18nProvider>)

describe('the desktop app', () => {
  it.each(['tauri.localhost', 'localhost', 'konclave-demo.vercel.app'])('never shows the notice (host %s)', (h) => {
    expect(render(h)).toBe('')
  })
})
