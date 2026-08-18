import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
// Self-hosted fonts - local-first, no external font CDN (weights used by lacre.css).
import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource/archivo/800.css'
import '@fontsource/spline-sans-mono/400.css'
import '@fontsource/spline-sans-mono/500.css'
import '@fontsource/spline-sans-mono/600.css'
import './lacre.css'
import App from './App.tsx'
import { RevealProvider } from './reveal'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { applyTheme, getTheme } from './theme'

// Apply the saved theme before first paint (white-first; dark is opt-in via Settings).
applyTheme(getTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <RevealProvider>
        <ToastProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ToastProvider>
      </RevealProvider>
    </I18nProvider>
  </StrictMode>,
)

// PWA: register the service worker so the app is installable and works offline (ADR-0005).
// PROD-only so dev HMR is never intercepted by the cache. The SW is network-first and never
// caches /api or /relay; the on-device share lives only in encrypted IndexedDB, never here.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}
