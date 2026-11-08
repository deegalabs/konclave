import type { ReactNode } from 'react'
import { useT } from '../i18n'

/** What a member sees of a vault's address: first the code to compare with the others, and the address
 *  only after they say they did. One gate for the finish screen and the vault card. */
export function CodeFirst({ code, compared, onCompared, children }: { code?: string; compared: boolean; onCompared: () => void; children: ReactNode }) {
  const t = useT()
  if (!code || compared) return <>{children}</>
  return (
    <div className="fp-card" role="note" onClick={(e) => e.stopPropagation()}>
      <span className="klab">{t('set.viewingCode')}</span>
      <div className="fp-code mono">{code}</div>
      <div className="fp-help dim">{t('set.viewingCodeHintFull')}</div>
      <button type="button" className="btn" onClick={onCompared}>{t('set.viewingCodeSeen')}</button>
    </div>
  )
}
