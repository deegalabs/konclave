import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

/**
 * Shared page chrome for the in-vault screens, so every screen opens and
 * closes with the same visual language:
 *
 *   [eyebrow]                                   [actions]
 *   Title
 *   subtitle
 *
 * Left column = eyebrow (klab) / title (h1) / subtitle; right column = actions
 * (export buttons, the quorum seal, a status stamp…). `eyebrow` is optional and
 * only rendered when a screen has one (Dashboard, Members, Proposal). All copy
 * is passed in by the caller - this component never hardcodes user-facing text.
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  back,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  // A breadcrumb/back affordance for drill-in screens (e.g. a proposal detail reached from several
  // origins). With `to` it links there; without, it steps back to where the user came from.
  back?: { to?: string; label: ReactNode }
}) {
  const nav = useNavigate()
  return (
    <header className="page-header">
      <div className="page-header-main">
        {back != null && (
          back.to != null ? (
            <Link to={back.to} className="page-back klab">‹ {back.label}</Link>
          ) : (
            <button type="button" className="page-back klab" onClick={() => nav(-1)}>‹ {back.label}</button>
          )
        )}
        {eyebrow != null && <span className="klab page-header-eyebrow">{eyebrow}</span>}
        <h1 className="h1">{title}</h1>
        {subtitle != null && <div className="page-header-sub">{subtitle}</div>}
      </div>
      {actions != null && <div className="page-header-actions">{actions}</div>}
    </header>
  )
}

/** The muted mono closing note at the foot of a screen (uses the shared `.foot` band). */
export function PageFooter({ children }: { children: ReactNode }) {
  return <footer className="foot page-footer">{children}</footer>
}

/**
 * The "and now?" connector that ties one screen to the next natural step in the flow
 * (receive → dashboard → propose → approve → ledger). Every read/hub screen closes with
 * one, so no screen is a dead end. `label` is the shared "Next step" eyebrow; `cta` is the
 * action copy; `to` is the destination route. All copy is passed in by the caller.
 */
export function NextStep({ label, cta, to }: { label: ReactNode; cta: ReactNode; to: string }) {
  return (
    <Link to={to} className="next-step" aria-label={typeof cta === 'string' ? cta : undefined}>
      <span className="next-step-label klab">{label}</span>
      <span className="next-step-cta">
        {cta}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </span>
    </Link>
  )
}
