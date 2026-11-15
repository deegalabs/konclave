import { useI18n, useTr } from './i18n'
import { payReadiness } from './pay-readiness'
import { fmtZecExact } from './format'

export interface ReadyCardProps {
  threshold: number
  seatsHere: number
  freeZat: number | null // null: no balance has been read yet
  hasBal: boolean
  backendsUp: boolean
}

/** The Dashboard's "can this vault pay right now" card. */
export function ReadyCard({ threshold, seatsHere, freeZat, hasBal, backendsUp }: ReadyCardProps) {
  const { t } = useI18n()
  const tr = useTr()
  const hasFree = freeZat !== null && freeZat > 0
  const { quorumReachable, canPay } = payReadiness({ threshold, seatsHere, hasFree, backendsUp })
  return (
    <section className={'ready ' + (canPay ? 'ok' : 'not')}>
      <div className="ready-top">
        <span className="ready-dot" aria-hidden="true" />
        <b>{canPay ? t('dashboard.readyYes') : t('dashboard.readyNo')}</b>
      </div>
      <span className={'chk ' + (quorumReachable ? 'y' : 'n')}>
        <span className="m" aria-hidden="true">{quorumReachable ? '✓' : '!'}</span>
        <span>{t('dashboard.readySeats', { present: seatsHere, threshold })}</span>
      </span>
      <span className={'chk ' + (hasFree ? 'y' : hasBal ? 'n' : 'u')}>
        <span className="m" aria-hidden="true">{hasFree ? '✓' : hasBal ? '!' : '…'}</span>
        <span>{hasFree
          ? tr('dashboard.readyFree', { amt: fmtZecExact((freeZat ?? 0) / 1e8) })
          : !hasBal
            ? t('dashboard.readyFreeUnknown')
            : t('dashboard.readyNoFree')}</span>
      </span>
      <span className={'chk ' + (backendsUp ? 'y' : 'n')}>
        <span className="m" aria-hidden="true">{backendsUp ? '✓' : '!'}</span>
        <span>{backendsUp ? t('dashboard.readyBackends') : t('dashboard.readyBackendsDown')}</span>
      </span>
    </section>
  )
}
