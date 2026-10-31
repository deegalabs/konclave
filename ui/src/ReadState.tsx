// "Could not read", said out loud (#320): one implementation for every screen
// that reads. A title the screen names, one honest line with the reason and who was asked (from
// read-failure.ts), what still holds, and "Try again". After a retry that fails again the message is
// mounted afresh, so a screen reader announces it again, and focus lands on it (the Members screen's
// pattern, #315). The compact form sits above rows a screen still holds from an earlier read.
import { useEffect, useRef, type ReactNode } from 'react'
import { useT } from './i18n'
import type { ReadFailureInfo } from './read-failure'

export type ReadStateProps = {
  /** What could not be read, in the screen's words ("Could not read the proposals"). */
  title: ReactNode
  /** Why and who was asked, when known; `null` gives the generic line. */
  failure: ReadFailureInfo | null
  onRetry: () => void
  /** True while a retry is running: the button says so and cannot be pressed twice. */
  busy?: boolean
  /** How many retries have failed; each one re-mounts the message and moves focus to it. */
  attempt?: number
  /** What still holds, in the screen's words; the generic sentence otherwise. */
  holds?: ReactNode
  /** The compact form: a line above rows the screen still shows from its last good read. */
  compact?: boolean
}

export default function ReadState({ title, failure, onRetry, busy = false, attempt = 0, holds, compact = false }: ReadStateProps) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (attempt > 0 && !compact) ref.current?.focus() }, [attempt, compact])
  const who = failure ? t(`read.who.${failure.source}`) : ''
  const why = failure ? t(`read.${failure.reason}`, { who }) : t('read.unknown')
  const button = <button className="btn ok sm-btn mt-sm" onClick={onRetry} disabled={busy}>{busy ? t('read.retrying') : t('read.retry')}</button>
  if (compact) {
    return (
      <div className="hint warn read-state compact" role="status">
        <span>{t('read.stale')} {why}</span> {button}
      </div>
    )
  }
  return (
    <div key={attempt} className="hint warn mt read-state" role="alert" tabIndex={-1} ref={ref} aria-labelledby="read-state-title">
      <h2 className="who-name mb-sm" id="read-state-title">{title}</h2>
      <p className="dim">{why} {holds ?? t('read.holds')}</p>
      {button}
    </div>
  )
}
