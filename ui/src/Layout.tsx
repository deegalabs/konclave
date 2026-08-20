import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Link, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Mark, LangToggle } from './components'
import { Identicon } from './avatar'
import { useT, useI18n } from './i18n'
import { getVault, health, isVaultUnlocked, IS_DEMO, type Vault } from './api'
import { VaultSignerProvider } from './VaultSigner'
import SigningPanel from './screens/SigningPanel'

// How many nav items live directly in the mobile bottom bar; the rest fold into "More".
const MOBILE_PRIMARY = 5

/** Persistent left rail + routed content. Wraps the in-vault screens; the
 *  onboarding screens (vault picker, intro, ceremony) render standalone. */
export default function Layout() {
  const t = useT()
  const { locale } = useI18n()
  const nav = useNavigate()
  const loc = useLocation()
  const [vault, setVault] = useState<Vault | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)

  // Close the mobile "More" sheet on any route change.
  useEffect(() => { setMoreOpen(false) }, [loc.pathname])

  // One-time bootstrap: decide whether the vault is reachable/unlocked and route.
  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on || !ok) return
      const v = await getVault()
      if (!on) return
      // A locked vault not unlocked this session → back to the unlock/picker.
      if (v?.locked && !isVaultUnlocked(v.id)) { nav('/vaults'); return }
      if (v) setVault(v)
    })()
    return () => { on = false }
  }, [])

  // Proactive liveness signal: poll the bridge/helper so a daemon that stops (or
  // comes back) is reflected without a reload - plus an immediate re-check when the
  // tab regains focus or the browser reports it's back online. Lightweight (a single
  // /api/health ping) and self-clearing on unmount. Skipped in demo mode, where
  // health() is intentionally false and the pill reads "demo", not "offline".
  useEffect(() => {
    if (IS_DEMO) return
    let on = true
    const check = () => { void health().then((ok) => { if (on) setLive(ok) }) }
    check()
    const id = window.setInterval(check, 20_000)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    return () => {
      on = false
      window.clearInterval(id)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
    }
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
    ['/ceremonies', t('nav.ceremonies'), <IconShield key="i" />],
    ['/members', t('nav.members'), <IconUsers key="i" />],
    ['/people', t('nav.people'), <IconUser key="i" />],
    ['/settings', t('nav.settings'), <IconGear key="i" />],
  ]

  return (
    <VaultSignerProvider>
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
          {items.map(([to, label, icon], i) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                'nav-item' + (isActive ? ' active' : '') + (i >= MOBILE_PRIMARY ? ' nav-overflow' : '')}
            >
              {icon}<span>{label}</span>
            </NavLink>
          ))}
          {/* Mobile-only: the overflow items fold into a "More" sheet. */}
          <button
            type="button"
            className={'nav-item nav-more-btn' + (moreOpen ? ' active' : '')}
            aria-expanded={moreOpen}
            aria-haspopup="menu"
            onClick={() => setMoreOpen((v) => !v)}
          >
            <IconMore /><span>{t('nav.more')}</span>
          </button>
        </nav>

        {moreOpen && (
          <>
            <div className="nav-more-scrim" onClick={() => setMoreOpen(false)} aria-hidden="true" />
            <div className="nav-more-sheet" role="menu" aria-label={t('nav.more')}>
              {items.slice(MOBILE_PRIMARY).map(([to, label, icon]) => (
                <NavLink
                  key={to}
                  to={to}
                  role="menuitem"
                  className={({ isActive }) => 'nav-more-row' + (isActive ? ' active' : '')}
                >
                  {icon}<span>{label}</span>
                </NavLink>
              ))}
            </div>
          </>
        )}

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
            {/* Three distinct states, one persistent live region:
                • demo  → neutral "demo" tag (health() is intentionally false here)
                • live  → green pill, bridge/helper answered
                • offline → warn/danger pill, a real vault we can't reach right now */}
            <span className="live-status" aria-live="polite">
              {IS_DEMO ? (
                <span className="live off"><i />{t('dashboard.demo')}</span>
              ) : live === true ? (
                <span className="live"><i />{t('dashboard.live')}</span>
              ) : live === false ? (
                <span className="live offline" role="status">
                  <i />{locale === 'pt-BR' ? 'Offline - sem conexão com o cofre' : "Offline - can't reach your vault"}
                </span>
              ) : null}
            </span>
            <Link to="/vaults" className="rail-switch">{t('nav.switchVault')} ▾</Link>
          </div>
          <div className="rail-lang"><LangToggle /></div>
        </div>
      </aside>

      <div className="railcontent">
        <Outlet />
      </div>
    </div>
    <SigningPanel />
    </VaultSignerProvider>
  )
}

/* - inline nav icons (stroked, 24-grid) - */
const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 } as const
function IconGrid() { return <svg viewBox="0 0 24 24" {...s}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg> }
function IconInbox() { return <svg viewBox="0 0 24 24" {...s}><path d="M3 12h5l2 3h4l2-3h5" /><path d="M5 5h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" /></svg> }
function IconRows() { return <svg viewBox="0 0 24 24" {...s}><path d="M4 6h16M4 12h16M4 18h10" /></svg> }
function IconDoc() { return <svg viewBox="0 0 24 24" {...s}><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v4h4M9 13h6M9 17h6" /></svg> }
function IconUsers() { return <svg viewBox="0 0 24 24" {...s}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M17 8.5a3 3 0 0 1 0 5M18.5 19a5 5 0 0 0-3-4.6" /></svg> }
function IconUser() { return <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="8" r="3.4" /><path d="M5 20a7 7 0 0 1 14 0" /></svg> }
function IconReceive() { return <svg viewBox="0 0 24 24" {...s}><path d="M12 4v11m0 0l-4-4m4 4l4-4" /><path d="M5 20h14" /></svg> }
function IconMore() { return <svg viewBox="0 0 24 24" {...s}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg> }
function IconGear() { return <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5" /></svg> }
function IconShield() { return <svg viewBox="0 0 24 24" {...s}><path d="M12 3l7 2.5v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9v-6z" /><path d="M9 12l2 2 4-4" /></svg> }
