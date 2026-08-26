import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { useReveal } from './reveal'
import { useI18n, useT } from './i18n'
import { scorePassphrase, generatePassphrase } from './passphrase'

/** The loading affordance: a centered spinning ring (the accent on a faint track) with the label
 *  below, announced via `role="status"`. Shown while an initial fetch is in flight instead of
 *  flashing a half-built page. Honors prefers-reduced-motion (the ring slows, never stops). */
export function Loading() {
  const t = useT()
  return (
    <div className="loader" role="status">
      <span className="loader-ring" aria-hidden="true" />
      <span className="loader-text">{t('common.loading')}</span>
    </div>
  )
}

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

/**
 * An action that exists but is not ready. Shown, never hidden: hiding it makes the product look
 * smaller than it is and leaves the reader wondering whether they missed something; a control that
 * fails makes them wonder whether the vault is broken. This says which it is, in one word, and
 * carries WHY as a title so nobody has to guess.
 *
 * `reason` is for the reader, not the changelog: say what does not work yet, not which module.
 */
export function Soon({ children, reason }: { children: ReactNode; reason: string }) {
  const t = useT()
  return (
    <span className="soon-wrap" title={reason}>
      {children}
      <span className="soon-badge" aria-hidden="true">{t('common.soon')}</span>
      <span className="visually-hidden">{reason}</span>
    </span>
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

/** Konclave mark - the radial-key emblem (silver spokes + blue keyhole), matching the logo. */
export function Mark() {
  const spokes = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg className="mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <g stroke="#7E93B0" strokeWidth="1.5" strokeLinecap="round">
        {spokes.map((a, i) => {
          const r = (a * Math.PI) / 180
          // alternate the ray length for a radiant "seal" burst
          const inner = i % 2 === 0 ? 12.4 : 13.4
          const outer = i % 2 === 0 ? 18.8 : 17.2
          return <line key={i} x1={20 + Math.cos(r) * inner} y1={20 + Math.sin(r) * inner} x2={20 + Math.cos(r) * outer} y2={20 + Math.sin(r) * outer} />
        })}
      </g>
      <circle cx="20" cy="19" r="7.2" stroke="#5C6F8B" strokeWidth="1.7" />
      <circle cx="20" cy="17.5" r="2.7" fill="var(--accent, #2F6FE0)" />
      <path d="M20 19.6 L18.6 25.3 L21.4 25.3 Z" fill="var(--accent, #2F6FE0)" />
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
            <span className="st-label">{label}</span>
          </span>
        </span>
      ))}
    </div>
  )
}

/**
 * A passphrase input with a live strength meter and a "magic" generate button (#221). Style-agnostic:
 * pass `inputClassName` to match the surrounding form (e.g. "cv-input" / "unlock-input" / "input").
 * The share it protects is only as safe as this passphrase, so the meter + one-tap strong generator
 * are the real security lever (not the file format).
 */
export function PassphraseField({
  value, onChange, placeholder, inputClassName = 'input', autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  inputClassName?: string
  autoFocus?: boolean
}) {
  const t = useT()
  const [show, setShow] = useState(false)
  const s = scorePassphrase(value)
  return (
    <div className="pf">
      <div className="pf-row">
        <input
          className={inputClassName + ' pf-input'}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="new-password"
          spellCheck={false}
        />
        <button type="button" className="pf-btn" title={show ? t('pass.hide') : t('pass.show')}
          aria-label={show ? t('pass.hide') : t('pass.show')} onClick={() => setShow((v) => !v)}>
          {show ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 3l18 18" />
              <path d="M10.6 10.7a2.5 2.5 0 0 0 3.4 3.4" />
              <path d="M9.5 5.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-2.4 3.2M6.2 6.2A17.5 17.5 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4-.9" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
              <circle cx="12" cy="12" r="2.6" />
            </svg>
          )}
        </button>
        <button type="button" className="pf-btn pf-gen" title={t('pass.generate')}
          aria-label={t('pass.generate')} onClick={() => { onChange(generatePassphrase()); setShow(true) }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 20L14 10" />
            <path d="M13 5.5l1.6.9.9 1.6.9-1.6L18 5.5l-1.6-.9-.9-1.6-.9 1.6z" fill="currentColor" stroke="none" />
            <path d="M18.5 12l.9 1.6 1.6.9-1.6.9-.9 1.6-.9-1.6-1.6-.9 1.6-.9z" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>
      {value && (
        <div className="pf-meter" aria-live="polite">
          <div className="pf-bars" aria-hidden="true">
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={'pf-bar' + (s.score >= i ? ' on s' + s.score : '')} />
            ))}
          </div>
          <span className={'pf-label s' + s.score}>{t('pass.' + s.label)}</span>
        </div>
      )}
    </div>
  )
}
