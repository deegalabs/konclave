import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Identicon } from './avatar'
import { useT } from './i18n'

// The "N members" link on the vault home, with the roster and the quorum in a popover (#602). It
// used to be CSS alone (`:hover` / `:focus-within`), so a keyboard user who tabbed onto the link
// got the popover over the page and could only close it by moving focus away. Content shown on
// hover or focus must be dismissable without moving either (WCAG 2.2, 1.4.13): the popover now has
// an open state, opens on hover and on focus, and closes on mouse leave, on blur and on Escape heard
// on the document while it is up, the way the roadmap's issue cards do (docs/IssueRef.tsx).

export type PeekMember = { name: string; pubkey?: string }

export default function MembersPeek({ members, thr, n, roster, creator, me }: {
  members: number
  thr: number
  n: number
  roster: PeekMember[]
  creator?: string | null
  me?: string | null
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const has = roster.length > 0

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <span
      className={'members-peek' + (open && has ? ' open' : '')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <Link className="link" to="/members" aria-describedby={has ? 'members-pop' : undefined} aria-expanded={has ? open : undefined}>{t('dashboard.membersCount', { n: members })}</Link>
      {has && (
        <span className="members-pop" role="tooltip" id="members-pop" aria-hidden={!open}>
          <span className="members-pop-head">{t('dashboard.membersQuorum', { t: thr, n })}</span>
          <span className="members-pop-list">
            {roster.map((m) => (
              <span className="members-pop-row" key={m.pubkey || m.name}>
                <Identicon seed={m.pubkey || m.name} size={22} />
                <span className="members-pop-name">{m.name}</span>
                {m.name === creator && <span className="klab members-pop-tag creator">{t('members.creatorShort')}</span>}
                {m.name === me && <span className="klab members-pop-tag">{t('members.youShort')}</span>}
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  )
}
