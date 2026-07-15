import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Link, Outlet, useNavigate } from 'react-router-dom'
import { Mark, LangToggle } from './components'
import { Identicon } from './avatar'
import { useT } from './i18n'
import { getVault, health, isVaultUnlocked, type Vault } from './api'

/** Persistent left rail + routed content. Wraps the in-vault screens; the
 *  onboarding screens (vault picker, intro, ceremony) render standalone. */
export default function Layout() {
  const t = useT()
  const nav = useNavigate()
  const [vault, setVault] = useState<Vault | null>(null)
  const [live, setLive] = useState<boolean | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      if (!ok) return
      const v = await getVault()
      if (!on) return
      // A locked vault not unlocked this session → back to the unlock/picker.
      if (v?.locked && !isVaultUnlocked(v.id)) { nav('/vaults'); return }
      if (v) setVault(v)
    })()
    return () => { on = false }
  }, [])

  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const seeds = vault?.member_list?.length
    ? vault.member_list.slice(0, 3).map((m) => m.name)
    : ['A', 'B', 'C']

  const items: [string, string, ReactNode][] = [
    ['/dashboard', t('nav.dashboard'), <IconGrid key="i" />],
    ['/receive', t('nav.receive'), <IconReceive key="i" />],
    ['/proposals', t('nav.proposals'), <IconInbox key="i" />],
    ['/payroll', t('nav.payroll'), <IconRows key="i" />],
    ['/ledger', t('nav.ledger'), <IconDoc key="i" />],
    ['/members', t('nav.members'), <IconUsers key="i" />],
    ['/people', t('nav.people'), <IconUser key="i" />],
  ]

  return (
    <div className="applayout">
      <aside className="rail">
        <Link to="/" className="brand">
          <Mark />
          <div>
            <div className="wm">KONCLAVE</div>
            <div className="brand-sub">{t('nav.brandSub')}</div>
          </div>
        </Link>

        <nav className="railnav" aria-label="Konclave">
          {items.map(([to, label, icon]) => (
            <NavLink key={to} to={to} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
              {icon}<span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="rail-foot">
          <Link to="/members" className="rail-quorum">
            <svg className="medallion" width="40" height="40" viewBox="0 0 42 42" fill="none" aria-hidden="true">
              <circle cx="21" cy="21" r="19.5" stroke="var(--line-strong)" />
              <circle cx="21" cy="21" r="14" stroke="var(--accent)" strokeOpacity=".4" strokeDasharray="2 3" />
              <path d="M21 8l11 6.4v12.8L21 34 10 27.2V14.4z" stroke="var(--accent)" strokeOpacity=".7" />
              <path d="M17 21l2.8 2.8L26 17.5" stroke="var(--success)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div>
              <div className="q">{thr} / {n}</div>
              <small>{t('seal.caption')}</small>
            </div>
          </Link>
          <div className="rail-avatars" aria-hidden="true">
            {seeds.map((s, i) => <Identicon key={i} seed={s} size={24} />)}
          </div>
          <div className="rail-bottom">
            {live === true && <span className="live"><i />{t('dashboard.live')}</span>}
            {live === false && <span className="live off"><i />{t('dashboard.demo')}</span>}
            <Link to="/" className="rail-switch">{t('nav.switchVault')} ▾</Link>
          </div>
          <div className="rail-lang"><LangToggle /></div>
        </div>
      </aside>

      <div className="railcontent">
        <Outlet />
      </div>
    </div>
  )
}

/* — inline nav icons (stroked, 24-grid) — */
const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 } as const
function IconGrid() { return <svg viewBox="0 0 24 24" {...s}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg> }
function IconInbox() { return <svg viewBox="0 0 24 24" {...s}><path d="M3 12h5l2 3h4l2-3h5" /><path d="M5 5h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" /></svg> }
function IconRows() { return <svg viewBox="0 0 24 24" {...s}><path d="M4 6h16M4 12h16M4 18h10" /></svg> }
function IconDoc() { return <svg viewBox="0 0 24 24" {...s}><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></svg> }
function IconUsers() { return <svg viewBox="0 0 24 24" {...s}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M17 8.5a3 3 0 0 1 0 5M18.5 19a5 5 0 0 0-3-4.6" /></svg> }
function IconUser() { return <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="8" r="3.4" /><path d="M5 20a7 7 0 0 1 14 0" /></svg> }
function IconReceive() { return <svg viewBox="0 0 24 24" {...s}><path d="M12 4v11m0 0l-4-4m4 4l4-4" /><path d="M5 20h14" /></svg> }
