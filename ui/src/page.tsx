import type { ReactNode } from 'react'

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
 * is passed in by the caller — this component never hardcodes user-facing text.
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
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
