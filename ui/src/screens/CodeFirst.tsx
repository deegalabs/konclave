import { Fragment, type ReactNode } from 'react'
import { useT } from '../i18n'

/** What a member sees of a vault's address: first the code to compare with the others, and the address
 *  only after they say they did. One gate for the finish screen and the vault card. */
export function CodeFirst({ code, compared, onCompared, children }: { code?: string; compared: boolean; onCompared: () => void; children: ReactNode }) {
  const t = useT()
  if (!code || compared) return <>{children}</>
  return (
    <div className="fp-card" role="note">
      <span className="klab">{t('set.viewingCode')}</span>
      {/* Members compare it group by group, out loud: a group split over two lines reads as two. Each
          group is one unbreakable piece, and a line may break only between groups. */}
      <div className="fp-code grouped mono">
        <span aria-hidden="true">
          {code.split('-').map((g, i, all) => (
            <Fragment key={i}>
              {i > 0 && <wbr />}
              <span className="fp-grp">{g}{i < all.length - 1 ? '-' : ''}</span>
            </Fragment>
          ))}
        </span>
        {/* Read whole, as before: the pieces above are for the eye. */}
        <span className="visually-hidden">{code}</span>
      </div>
      <div className="fp-help dim">{t('set.viewingCodeHintFull')}</div>
      <button type="button" className="btn" onClick={onCompared}>{t('set.viewingCodeSeen')}</button>
    </div>
  )
}
