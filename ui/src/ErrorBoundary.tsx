import { Component, type ReactNode } from 'react'
import { Mark } from './components'

type Props = { children: ReactNode }
type State = { error: Error | null }

/** Global error boundary: an uncaught render/throw in any screen is caught here and shown as a
 *  calm, actionable fallback instead of a white screen. No telemetry (§6.2) — the error is logged
 *  to the local console only, never phoned home. The app stays recoverable (reload / back to vaults). */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    // Local log only — never transmit (data minimization).
    console.error('Konclave hit an unexpected error:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, position: 'relative', zIndex: 1 }}>
        <div style={{
          maxWidth: 440, textAlign: 'center', background: 'var(--surface-1)', border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg)', padding: '34px 30px', boxShadow: 'var(--shadow-overlay)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}><Mark /></div>
          <div className="klab">Something broke</div>
          <h1 className="h1" style={{ marginTop: 6 }}>The screen hit an unexpected error.</h1>
          <p className="dim" style={{ marginTop: 8 }}>
            Your vault and your share are safe on this device — nothing was sent. Reload to continue.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22 }}>
            <button className="btn ok" onClick={() => window.location.reload()}>Reload</button>
            <a className="btn ghost" href="#/vaults">My vaults</a>
          </div>
        </div>
      </div>
    )
  }
}
