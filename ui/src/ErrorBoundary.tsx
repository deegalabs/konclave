import { Component, type ReactNode } from 'react'
import { Mark } from './components'
import { translateStatic, type Locale } from './i18n'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Global error boundary: an uncaught render/throw in any screen is caught here and shown as a
 *  calm, actionable fallback instead of a white screen. No telemetry (§6.2) - the error is logged
 *  to the local console only, never phoned home. The app stays recoverable (reload / back to vaults). */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // Local log only - never transmit (data minimization).
    console.error('Konclave hit an unexpected error:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <CrashScreen />
  }
}

/** The fallback itself. A class component cannot use hooks, and the provider above may be part of
 *  what crashed, so the dictionary is read directly, in the member's saved language (#318). */
export function CrashScreen({ locale }: { locale?: Locale }) {
  const t = (k: string) => translateStatic(k, undefined, locale)
  return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, position: 'relative', zIndex: 1 }}>
        <div style={{
          maxWidth: 440, textAlign: 'center', background: 'var(--surface-1)', border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg)', padding: '34px 30px', boxShadow: 'var(--shadow-overlay)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}><Mark /></div>
          <div className="klab">{t('crash.label')}</div>
          <h1 className="h1" style={{ marginTop: 6 }}>{t('crash.title')}</h1>
          <p className="dim" style={{ marginTop: 8 }}>{t('crash.lead')}</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22 }}>
            <button className="btn ok" onClick={() => window.location.reload()}>{t('crash.reload')}</button>
            <a className="btn ghost" href="#/vaults">{t('crash.vaults')}</a>
          </div>
        </div>
      </div>
    )
}
