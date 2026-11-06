import { StrictMode } from 'react'
import { HashRouter } from 'react-router-dom'
import App from './App.tsx'
import ErrorBoundary from './ErrorBoundary'
import { RevealProvider } from './reveal'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'

/**
 * The whole tree main.tsx mounts, kept in its own module so a test renders the same one.
 *
 * The error boundary is the OUTERMOST element. It used to sit inside App, around the routes, so a
 * throw in a provider, the router or the app frame left the page white. The crash screen needs no
 * provider (it reads the dictionary directly), so it can stand above all of them. App keeps its own
 * boundary around the routes: a screen that crashes then leaves the frame standing, update banner
 * included, which is how the web delivers the fix for that crash.
 */
export function Root() {
  return (
    <StrictMode>
      <ErrorBoundary>
        <I18nProvider>
          <RevealProvider>
            <ToastProvider>
              <HashRouter>
                <App />
              </HashRouter>
            </ToastProvider>
          </RevealProvider>
        </I18nProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}
