import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Link, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Mark, LangToggle } from './components'
import { Identicon } from './avatar'
import { useT, useI18n } from './i18n'
import { getVault, health, isVaultUnlocked, IS_DEMO, type Vault } from './api'
import { VaultSignerProvider } from './VaultSigner'
import { LoadingProvider, TopProgress } from './loading'
import SigningPanel from './screens/SigningPanel'

// The money + governance spine shown directly in the mobile bottom bar; everything else folds into
// "More". (On mobile the rail is a flat tab bar, so the desktop bands collapse away.)
const MOBILE_PRIMARY = new Set(['/dashboard', '/pay', '/payroll', '/activity', '/members'])

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

  // Rail grouped into three intent bands (ADR-0009, GSP IA #156) so a governance vault reads as
  // VAULT / GOVERNANCE / ACTIONS, not a flat wallet with sibling tabs:
  //  · VAULT      - the vault itself: overview + receiving.
  //  · GOVERNANCE - what needs the quorum: approvals + the signers who hold shares and vote.
  //  · ACTIONS    - the two compose faces that START a governance flow (Pay/Payroll).
  // Settings sits below the bands. Beneficiaries is NOT a rail peer: it is a payee address-book that
  // only feeds Pay/Payroll, reached contextually there ("Manage payees"), never a destination.
  type NavItem = [string, string, ReactNode]
  const bands: { label: string; items: NavItem[] }[] = [
    { label: t('nav.bandVault'), items: [
      ['/dashboard', t('nav.dashboard'), <IconGrid key="i" />],
      ['/receive', t('nav.receive'), <IconReceive key="i" />],
    ] },
    { label: t('nav.bandGovernance'), items: [
      ['/activity', t('nav.activity'), <IconInbox key="i" />],
      ['/members', t('nav.members'), <IconUsers key="i" />],
    ] },
    { label: t('nav.bandDo'), items: [
      ['/pay', t('nav.pay'), <IconSend key="i" />],
      ['/payroll', t('nav.payroll'), <IconRows key="i" />],
    ] },
  ]
  const tail: NavItem[] = [['/settings', t('nav.settings'), <IconGear key="i" />]]
  const allItems: NavItem[] = [...bands.flatMap((b) => b.items), ...tail]
  const overflow = allItems.filter(([to]) => !MOBILE_PRIMARY.has(to))
  const navClass = (to: string) => ({ isActive }: { isActive: boolean }) =>
    'nav-item' + (isActive ? ' active' : '') + (MOBILE_PRIMARY.has(to) ? '' : ' nav-overflow')

  return (
    <LoadingProvider>
    <TopProgress />
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
          {/* Desktop: three labelled bands. Mobile: `.rail-band` becomes display:contents and the
              labels hide, so these flatten into the tab bar (primary items) + a "More" sheet. */}
          {bands.map((band) => (
            <div className="rail-band" key={band.label}>
              <span className="rail-band-label">{band.label}</span>
              {band.items.map(([to, label, icon]) => (
                <NavLink key={to} to={to} className={navClass(to)}>{icon}<span>{label}</span></NavLink>
              ))}
            </div>
          ))}
          <div className="rail-band rail-band-tail">
            {tail.map(([to, label, icon]) => (
              <NavLink key={to} to={to} className={navClass(to)}>{icon}<span>{label}</span></NavLink>
            ))}
          </div>
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
              {overflow.map(([to, label, icon]) => (
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
    </LoadingProvider>
  )
}

/* - inline nav icons (stroked, 24-grid) - */
const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 } as const
function IconGrid() { return <svg viewBox="0 0 24 24" {...s}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg> }
function IconInbox() { return <svg viewBox="0 0 24 24" {...s}><path d="M3 12h5l2 3h4l2-3h5" /><path d="M5 5h14l2 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" /></svg> }
function IconRows() { return <svg viewBox="0 0 24 24" {...s}><path d="M4 6h16M4 12h16M4 18h10" /></svg> }
function IconSend() { return <svg viewBox="0 0 24 24" {...s}><path d="M12 20V4m0 0l-5 5m5-5l5 5" /></svg> }
function IconUsers() { return <svg viewBox="0 0 24 24" {...s}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M17 8.5a3 3 0 0 1 0 5M18.5 19a5 5 0 0 0-3-4.6" /></svg> }
function IconReceive() { return <svg viewBox="0 0 24 24" {...s}><path d="M12 4v11m0 0l-4-4m4 4l4-4" /><path d="M5 20h14" /></svg> }
function IconMore() { return <svg viewBox="0 0 24 24" {...s}><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg> }
function IconGear() { return <svg viewBox="0 0 24 24" {...s}><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5" /></svg> }
