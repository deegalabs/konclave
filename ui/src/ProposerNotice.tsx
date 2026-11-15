import { ACTING_KEYS, type ActingAs } from './api'
import { useI18n } from './i18n'

/** What a proposing screen says when it cannot name the proposer, and the roster warning beside the
 *  name when this device's own list disagrees. Neither is a place to act; both are a reason. */
export function ProposerNotice({ acting, differs }: { acting: ActingAs | null; differs: boolean }) {
  const { t } = useI18n()
  return (
    <div role="status">
      {acting && !acting.ok && <div className="hint warn mt-sm">{t(ACTING_KEYS[acting.why])}</div>}
      {differs && <div className="hint warn mt-sm">{t('members.rosterDiffers')}</div>}
    </div>
  )
}
