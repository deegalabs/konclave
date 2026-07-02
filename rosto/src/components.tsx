import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useReveal } from './reveal'

/** Konclave mark — the radial-key emblem (silver spokes + blue keyhole), matching the logo. */
export function Mark() {
  const spokes = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg className="mark" viewBox="0 0 40 40" fill="none" aria-hidden="true"
      style={{ filter: 'drop-shadow(0 0 4px rgba(87,166,255,.35))' }}>
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
      {right}
    </header>
  )
}

/** A sensitive value hidden behind the redaction bar until revealed. */
export function Secret({ children, sm }: { children: ReactNode; sm?: boolean }) {
  const { toggle } = useReveal()
  return (
    <span className={'secret' + (sm ? ' sm' : '')}>
      {children}
      <span className="bar" onClick={toggle} />
    </span>
  )
}

/** The reveal / hide toggle. */
export function RevealButton() {
  const { revealed, toggle } = useReveal()
  return (
    <button className="reveal-btn" aria-pressed={revealed} onClick={toggle}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="2.4" />
      </svg>
      {revealed ? 'Ocultar' : 'Revelar'}
    </button>
  )
}

/** The wax seal with the quorum (t of n). */
export function Seal({ t, n, cap = 'Assinaturas' }: { t: number; n: number; cap?: string }) {
  return (
    <div className="seal-wrap">
      <div className="seal-emb">
        <svg width="90" height="90" viewBox="0 0 96 96" fill="none" aria-hidden="true"
          style={{ filter: 'drop-shadow(0 0 8px rgba(87,166,255,.28))' }}>
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
      <div className="seal-cap">{cap}</div>
    </div>
  )
}

const CERIMONIA_STEPS = ['Definir', 'Convidar', 'Criar', 'Endereço']

/** The ceremony stepper (1-based current step). */
export function Stepper({ step }: { step: number }) {
  return (
    <div className="steps">
      {CERIMONIA_STEPS.map((label, i) => (
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
