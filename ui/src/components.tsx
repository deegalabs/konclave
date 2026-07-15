import { useEffect, useRef, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { useReveal } from './reveal'
import { useI18n, useT } from './i18n'

/** Enter/Space handler for elements given `role="button"` + `tabIndex`.
 *  Ignores events bubbling up from nested controls so a row doesn't fire when
 *  an inner link/button is activated. */
export function activateOnKey(fn: () => void) {
  return (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() }
  }
}

/** Accessible modal dialog: role/aria-modal/aria-labelledby, focus moved inside
 *  on open, a Tab focus-trap, Esc to close, and focus returned to the trigger on
 *  close. Backdrop click closes (via onClose). Keeps the existing overlay/card
 *  classes so the visual design is unchanged. */
export function Dialog({ labelledBy, onClose, className, cardClassName, children }: {
  labelledBy: string
  onClose: () => void
  className: string
  cardClassName: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const node = ref.current
    const prev = document.activeElement as HTMLElement | null
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    const focusables = () => (node ? Array.from(node.querySelectorAll<HTMLElement>(sel)) : [])
    ;(focusables()[0] ?? node)?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      const first = f[0], last = f[f.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.() }
  }, [])
  return (
    <div className={className} onClick={() => onCloseRef.current()}>
      <div ref={ref} className={cardClassName} role="dialog" aria-modal="true" aria-labelledby={labelledBy} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

/** Language toggle (PT / EN). Keyboard-operable buttons; the choice persists per device. */
export function LangToggle() {
  const { locale, setLocale, t } = useI18n()
  return (
    <span className="lang-toggle" role="group" aria-label={t('lang.label')}>
      <button type="button" className={'lang-btn' + (locale === 'pt-BR' ? ' on' : '')}
        aria-pressed={locale === 'pt-BR'} onClick={() => setLocale('pt-BR')}>{t('lang.pt')}</button>
      <button type="button" className={'lang-btn' + (locale === 'en' ? ' on' : '')}
        aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>{t('lang.en')}</button>
    </span>
  )
}

/** Konclave mark — the radial-key emblem (silver spokes + blue keyhole), matching the logo. */
export function Mark() {
  const spokes = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg className="mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <g stroke="#c6cfd9" strokeWidth="1.3" strokeLinecap="round" opacity="0.9">
        {spokes.map((a, i) => {
          const r = (a * Math.PI) / 180
          return <line key={i} x1={20 + Math.cos(r) * 13} y1={20 + Math.sin(r) * 13} x2={20 + Math.cos(r) * 18} y2={20 + Math.sin(r) * 18} />
        })}
      </g>
      <circle cx="20" cy="19" r="7" stroke="#c6cfd9" strokeWidth="1.5" />
      <circle cx="20" cy="17.6" r="2.4" fill="#57a6ff" />
      <path d="M20 19.4 L18.7 25 L21.3 25 Z" fill="#57a6ff" />
    </svg>
  )
}

/** Letterhead bar with the wordmark and an optional right-hand slot. */
export function Letterhead({ right }: { right?: ReactNode }) {
  return (
    <header className="lh">
      <Link to="/" className="brand" style={{ textDecoration: 'none', color: 'inherit' }}>
        <Mark />
        <span className="wm">KONCLAVE</span>
      </Link>
      <span className="lh-right">
        {right}
        <LangToggle />
      </span>
    </header>
  )
}

/** A sensitive value hidden behind the redaction bar (tarja) until revealed.
 *  The bar is a real button so the privacy gesture is keyboard-operable. */
export function Secret({ children, sm }: { children: ReactNode; sm?: boolean }) {
  const { revealed, toggle } = useReveal()
  const t = useT()
  return (
    <span className={'secret' + (sm ? ' sm' : '')}>
      {children}
      <button
        type="button"
        className="bar"
        data-label={t('secret.tarja')}
        onClick={toggle}
        aria-pressed={revealed}
        aria-label={revealed ? t('common.hide') : t('common.reveal')}
      />
    </span>
  )
}

/** The reveal / hide toggle. */
export function RevealButton() {
  const { revealed, toggle } = useReveal()
  const t = useT()
  return (
    <button className="reveal-btn" aria-pressed={revealed} onClick={toggle}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="2.4" />
      </svg>
      {revealed ? t('common.hide') : t('common.reveal')}
    </button>
  )
}

/** The wax seal with the quorum (t of n). */
export function Seal({ t, n, cap }: { t: number; n: number; cap?: string }) {
  const tr = useT()
  const caption = cap ?? tr('seal.caption')
  return (
    <div className="seal-wrap">
      <div className="seal-emb">
        <svg width="90" height="90" viewBox="0 0 96 96" fill="none" aria-hidden="true">
          <circle cx="48" cy="48" r="45" stroke="#57a6ff" strokeWidth="1" />
          <circle cx="48" cy="48" r="39" stroke="#57a6ff" strokeWidth="2.4" />
          <circle cx="48" cy="48" r="34" stroke="#c6cfd9" strokeWidth=".6" strokeDasharray="1 3" />
          <g stroke="#8ba7c9" strokeWidth=".7" opacity=".8">
            <circle cx="48" cy="48" r="30" />
            <path d="M48 18c9 12 9 48 0 60M48 18c-9 12-9 48 0 60M18 48c12-9 48-9 60 0M18 48c12 9 48 9 60 0" />
          </g>
        </svg>
        <span className="num">
          {t}/{n}
        </span>
      </div>
      <div className="seal-cap">{caption}</div>
    </div>
  )
}

/** The ceremony stepper (1-based current step). */
export function Stepper({ step }: { step: number }) {
  const t = useT()
  const steps = [t('stepper.define'), t('stepper.invite'), t('stepper.create'), t('stepper.address')]
  return (
    <div className="steps">
      {steps.map((label, i) => (
        <span className="st-wrap" key={label}>
          {i > 0 && <span className="seg" />}
          <span className={'st' + (i + 1 === step ? ' on' : '')}>
            <span className="pip" />
            {label}
          </span>
        </span>
      ))}
    </div>
  )
}
