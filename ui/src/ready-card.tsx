import { useI18n } from './i18n'
import { payReadiness } from './pay-readiness'
import { fmtZecExact } from './format'
import { SentenceWithSecret, SECRET_MARK } from './components'

export interface ReadyCardProps {
  threshold: number
  total: number
  freeZat: number | null // null: no balance has been read yet
  hasBal: boolean
  backendsUp: boolean
}

/** The Dashboard's "can this vault pay right now" card. */
export function ReadyCard({ threshold, total, freeZat, hasBal, backendsUp }: ReadyCardProps) {
  const { t } = useI18n()
  const hasFree = freeZat !== null && freeZat > 0
  const { canPay } = payReadiness({ hasFree, backendsUp })
  return (
    <section className={'ready ' + (canPay ? 'ok' : 'not')}>
      <div className="ready-top">
        <span className="ready-dot" aria-hidden="true" />
        <b>{canPay ? t('dashboard.readyYes') : t('dashboard.readyNo')}</b>
      </div>
      {/* A fact about the vault, not a measure of who is online: it never ages and claims nothing. */}
      {threshold > 0 && total > 0 && (
        <span className="chk">
          <span className="m" aria-hidden="true">·</span>
          <span>{t('dashboard.readyQuorum', { threshold, total })}</span>
        </span>
      )}
      <span className={'chk ' + (hasFree ? 'y' : hasBal ? 'n' : 'u')}>
        <span className="m" aria-hidden="true">{hasFree ? '✓' : hasBal ? '!' : '…'}</span>
        <span>{hasFree
          ? <SentenceWithSecret sentence={t('dashboard.readyFree', { amt: SECRET_MARK })} sm>{fmtZecExact((freeZat ?? 0) / 1e8)}</SentenceWithSecret>
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
