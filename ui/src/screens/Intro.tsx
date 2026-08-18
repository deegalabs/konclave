import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Dialog } from '../components'
import { useT, useTr, useI18n } from '../i18n'
import { getTheme, setTheme, type Theme } from '../theme'
import { IS_NET } from '../api'
import '../landing-fx.css'

// External destinations (honest §6.13–6.15): the real app, the public repo, the releases page.
const GITHUB = 'https://github.com/deegalabs/konclave'
const RELEASES = `${GITHUB}/releases`
// Hero background is VIDEO-READY: set this to a bundled muted-loop asset later and it becomes the
// backdrop automatically (only when prefers-reduced-motion is OFF). Until then the CSS-3D vault is
// the default AND the fallback — plugging in a video is this one line.
const HERO_VIDEO_SRC: string | null = null

// A single directory of every live surface. Kept (exported, so it isn't an unused local) rather than
// deleted: the copy migrates to Docs in a follow-up, and this is the reference for what belongs there.
export const EXPLORE: Record<'pt-BR' | 'en', { eyebrow: string; title: string; items: { to: string; name: string; desc: string; tag?: string }[] }> = {
  'pt-BR': {
    eyebrow: 'EXPLORE',
    title: 'Tudo pra experimentar, num lugar só',
    items: [
      { to: '/vaults', name: 'Abrir o cofre', desc: 'O produto rodando: pagamento, folha, aprovações e registro.', tag: 'app' },
      { to: '/proof', name: 'Comprovação na blockchain', desc: 'Confira você mesmo, no explorador público, as transações reais do Konclave na mainnet.', tag: 'prova' },
      { to: '/net', name: 'Cofre entre dispositivos', desc: 'Crie e opere o mesmo cofre no celular e no computador. Nenhum servidor vê um segredo.' },
      { to: '/lab', name: 'Laboratório', desc: 'Veja a criptografia acontecer: assinatura no navegador, recuperação e herança, ao vivo.', tag: 'demo' },
      { to: '/docs', name: 'Documentação', desc: 'Como funciona, a arquitetura e os diagramas.' },
    ],
  },
  en: {
    eyebrow: 'EXPLORE',
    title: 'Everything to try, in one place',
    items: [
      { to: '/vaults', name: 'Open the vault', desc: 'The product running: payment, payroll, approvals and ledger.', tag: 'app' },
      { to: '/proof', name: 'Proof on the blockchain', desc: 'Check for yourself, on the public explorer, Konclave’s real mainnet transactions.', tag: 'proof' },
      { to: '/net', name: 'Vault across devices', desc: 'Create and run one vault on your phone and your computer. No server ever sees a secret.' },
      { to: '/lab', name: 'Laboratory', desc: 'Watch the cryptography happen: browser signing, recovery and inheritance, live.', tag: 'demo' },
      { to: '/docs', name: 'Documentation', desc: 'How it works, the architecture and the diagrams.' },
    ],
  },
}

/** Konclave mark — the radial-key emblem, rendered BIGGER + BOLDER for the landing (thicker
 *  spokes/rings than the letterhead mark, so it reads strong at hero scale). */
function FxMark({ size = 40 }: { size?: number }) {
  const spokes = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg className="fx-mark" width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <g stroke="var(--silver)" strokeWidth="2.3" strokeLinecap="round" opacity="0.95">
        {spokes.map((a, i) => {
          const r = (a * Math.PI) / 180
          return <line key={i} x1={20 + Math.cos(r) * 12} y1={20 + Math.sin(r) * 12} x2={20 + Math.cos(r) * 18} y2={20 + Math.sin(r) * 18} />
        })}
      </g>
      <circle cx="20" cy="19" r="7.6" stroke="var(--silver)" strokeWidth="2.6" />
      <circle cx="20" cy="17.3" r="3" fill="var(--accent)" />
      <path d="M20 19.6 L18.3 25.6 L21.7 25.6 Z" fill="var(--accent)" />
    </svg>
  )
}

const DL = <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>

const LINUX: [name: string, ext: string] = ['Linux', '.deb / .AppImage']
const DESKTOP_PLATFORMS: Array<[name: string, ext: string]> = [
  ['Windows', '.msi'],
  ['macOS', '.dmg'],
  LINUX,
]

/** Landing — a single futuristic section: sticky header, 3D-vault (video-ready) background,
 *  hero, and an honest install modal. The app's marketing front door. */
export default function Intro() {
  const t = useT()
  const tr = useTr()
  const { locale, setLocale } = useI18n()
  const gridRef = useRef<HTMLCanvasElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [othersOpen, setOthersOpen] = useState(false)
  const [theme, setThemeLocal] = useState<Theme>(getTheme)

  const reduced = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  )
  const showVideo = Boolean(HERO_VIDEO_SRC) && !reduced

  // Detected OS drives which desktop installer is offered first (progressive disclosure of the rest).
  const os = useMemo(() => {
    if (typeof navigator === 'undefined') return 'Linux'
    const ua = navigator.userAgent
    if (/Win/i.test(ua)) return 'Windows'
    if (/Mac/i.test(ua)) return 'macOS'
    return 'Linux'
  }, [])
  const primary = DESKTOP_PLATFORMS.find((p) => p[0] === os) ?? LINUX
  const others = DESKTOP_PLATFORMS.filter((p) => p[0] !== os)

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    setThemeLocal(next)
  }

  // Header border-on-scroll.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Perspective grid: animates via rAF, PAUSES when the tab is hidden, and renders a single static
  // frame under prefers-reduced-motion. Re-runs on theme change so the line colour tracks the theme.
  useEffect(() => {
    const canvas = gridRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    let tick = 0
    let raf = 0
    const size = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
    size()
    const draw = () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      const w = canvas.width, h = canvas.height, cx = w * 0.66, horizon = h * 0.14
      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = dark ? 'rgba(87,166,255,.09)' : 'rgba(47,111,208,.08)'
      ctx.lineWidth = 1
      for (let i = -22; i <= 22; i++) {
        const gx = cx + i * 72
        ctx.beginPath(); ctx.moveTo(cx + (gx - cx) * 0.14, horizon); ctx.lineTo(gx, h); ctx.stroke()
      }
      for (let j = 0; j < 18; j++) {
        const p = (j + (reduced ? 0 : (tick * 0.02) % 1)) / 18
        const yy = horizon + (h - horizon) * p * p
        ctx.globalAlpha = Math.min(1, p * 1.4)
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke()
      }
      ctx.globalAlpha = 1
      tick++
      if (!reduced && !document.hidden) raf = requestAnimationFrame(draw)
    }
    draw()
    const onResize = () => { size(); if (reduced) draw() }
    const onVis = () => {
      if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0 }
      else if (!reduced && !raf) draw()
    }
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [theme, reduced])

  const bolts = Array.from({ length: 12 }, (_, i) => (i * 30 * Math.PI) / 180)

  const themeBtn = (
    <button type="button" className="fx-ticon" aria-pressed={theme === 'dark'} aria-label={t('landing.fxThemeToggle')} onClick={toggleTheme}>
      {theme === 'dark' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></svg>
      )}
    </button>
  )

  const langToggle = (
    <span className="fx-lang" role="group" aria-label="Language">
      <button type="button" className={locale === 'en' ? 'on' : ''} aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
      <button type="button" className={locale === 'pt-BR' ? 'on' : ''} aria-pressed={locale === 'pt-BR'} onClick={() => setLocale('pt-BR')}>PT</button>
    </span>
  )

  return (
    <div className="fx-landing">
      {/* video-ready backdrop: video (future) OR the CSS-3D vault, under a readability scrim */}
      <div className="fx-bg" aria-hidden="true">
        <canvas ref={gridRef} className="fx-grid" />
        {showVideo ? (
          <video className="fx-bg-video" src={HERO_VIDEO_SRC ?? undefined} autoPlay muted loop playsInline />
        ) : (
          <div className="fx-ambient">
            <div className="fx-scene">
              <div className="fx-halo" />
              <div className="fx-vault">
                <div className="fx-disc" />
                <div className="fx-ring fx-r1" />
                <div className="fx-ring fx-r2" />
                <div className="fx-ring fx-r3" />
                <div className="fx-ring fx-r4" />
                <div className="fx-bolts">
                  {bolts.map((a, i) => (
                    <span key={i} className="fx-bolt" style={{ left: `calc(50% + ${Math.cos(a) * 50}% - 4.5px)`, top: `calc(50% + ${Math.sin(a) * 50}% - 4.5px)` }} />
                  ))}
                </div>
              </div>
              <div className="fx-hub">
                <svg width="46" height="46" viewBox="0 0 40 40" fill="none">
                  <g stroke="var(--silver)" strokeWidth="1.4" strokeLinecap="round"><line x1="20" y1="4" x2="20" y2="8" /><line x1="20" y1="32" x2="20" y2="36" /><line x1="4" y1="20" x2="8" y2="20" /><line x1="32" y1="20" x2="36" y2="20" /></g>
                  <circle cx="20" cy="19" r="7.5" stroke="var(--silver)" strokeWidth="1.5" />
                  <circle cx="20" cy="17.4" r="2.7" fill="var(--accent)" />
                  <path d="M20 19.4 L18.5 25.5 L21.5 25.5 Z" fill="var(--accent)" />
                </svg>
              </div>
            </div>
          </div>
        )}
        <div className="fx-scrim" />
      </div>

      {/* header */}
      <header className={'fx-hdr' + (scrolled ? ' scrolled' : '')}>
        <Link to="/" className="fx-brand">
          <FxMark size={42} />
          <span className="fx-wm">KONCLAVE</span>
        </Link>
        <span className="fx-sp" />
        <span className="fx-desk">
          <Link className="fx-hlink" to="/docs">Docs</Link>
          <a className="fx-hlink" href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          {langToggle}
          {themeBtn}
          <button type="button" className="fx-btn dl" onClick={() => setInstallOpen(true)}>{DL}{t('landing.fxDownload')}</button>
        </span>
        <button type="button" className="fx-btn dl fx-mobile-dl" onClick={() => setInstallOpen(true)}>{t('landing.fxDownload')}</button>
        <button type="button" className="fx-menu-btn" aria-expanded={menuOpen} aria-label="Menu" onClick={() => setMenuOpen((v) => !v)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
      </header>

      {menuOpen && (
        <div className="fx-menu-panel">
          <div className="fx-menu-row">
            <Link className="fx-hlink" to="/docs" onClick={() => setMenuOpen(false)}>Docs</Link>
            <a className="fx-hlink" href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          </div>
          <div className="fx-menu-row">{langToggle}{themeBtn}</div>
          <button type="button" className="fx-btn dl" onClick={() => { setMenuOpen(false); setInstallOpen(true) }}>{DL}{t('landing.fxDownload')}</button>
        </div>
      )}

      {/* hero */}
      <main className="fx-hero">
        <div className="fx-hero-in">
          <FxMark size={76} />
          <span className="fx-eyebrow"><span className="fx-dot" />{t('landing.eyebrow')}</span>
          <h1>{t('landing.h1')}</h1>
          <p className="fx-sub">{tr('landing.sub')}</p>
          <div className="fx-ctas">
            <Link className="fx-btn pri" to={IS_NET ? '/net' : '/create'}>
              <span>{t('landing.finalCtaCreate')}</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
            <button type="button" className="fx-btn dl" onClick={() => setInstallOpen(true)}>{DL}{t('landing.fxDownloadApp')}</button>
            <a className="fx-demolink" href="?demo=1#/vaults">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z" /></svg>
              {t('demo.watchCta')}
            </a>
          </div>
          <div className="fx-trust">
            <span>{tr('landing.fxTrustLocal')}</span><i />
            <span>{t('landing.fxTrustNoTelemetry')}</span><i />
            <span>{t('landing.fxTrustMainnet')}</span><i />
            <span>{t('landing.fxTrustLicense')}</span>
          </div>
          <p className="fx-docsline">{t('landing.fxDocsLine')} <Link to="/docs">{t('landing.fxDocsLink')}</Link></p>
        </div>
      </main>

      {/* install modal — honest labels (§6.15): extension is roadmap, no fake button; desktop v0.2.0 */}
      {installOpen && (
        <Dialog labelledBy="fx-il-t" onClose={() => setInstallOpen(false)} className="fx-modal" cardClassName="fx-mcard">
          <button type="button" className="fx-mx" onClick={() => setInstallOpen(false)}>✕ {t('landing.fxClose')}</button>
          <h2 id="fx-il-t">{t('landing.fxInstallTitle')}</h2>
          <p className="fx-msub">{t('landing.fxInstallSub')}</p>

          <div className="fx-plat hi">
            <span className="fx-pic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg></span>
            <div className="fx-m">
              <div className="fx-t">{t('landing.fxWebTitle')} <span className="fx-chip ok">{t('landing.fxLive')}</span></div>
              <div className="fx-d">{t('landing.fxWebDesc')}</div>
            </div>
            <Link className="fx-btn pri fx-mini" to="/vaults" onClick={() => setInstallOpen(false)}>{t('landing.fxOpen')}</Link>
          </div>

          <div className="fx-plat">
            <span className="fx-pic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="13" rx="1.5" /><path d="M8 20h8M12 17v3" /></svg></span>
            <div className="fx-m">
              <div className="fx-t">{primary[0]}</div>
              <div className="fx-d">{t('landing.fxDesktopDesc')}</div>
              <div className="fx-ver">v0.2.0 · {primary[1]}</div>
            </div>
            <a className="fx-btn dl fx-mini" href={RELEASES} target="_blank" rel="noreferrer">{t('landing.fxDownload')}</a>
          </div>
          <button type="button" className="fx-other" aria-expanded={othersOpen} onClick={() => setOthersOpen((v) => !v)}>
            {t('landing.fxOtherPlatforms')} {othersOpen ? '▴' : '▾'}
          </button>
          {othersOpen && others.map((p) => (
            <div className="fx-plat" key={p[0]}>
              <span className="fx-pic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="2" /></svg></span>
              <div className="fx-m">
                <div className="fx-t">{p[0]}</div>
                <div className="fx-ver">v0.2.0 · {p[1]}</div>
              </div>
              <a className="fx-btn dl fx-mini" href={RELEASES} target="_blank" rel="noreferrer">{t('landing.fxDownload')}</a>
            </div>
          ))}

          <div className="fx-plat">
            <span className="fx-pic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></svg></span>
            <div className="fx-m">
              <div className="fx-t">{t('landing.fxMobileTitle')}</div>
              <div className="fx-d">{t('landing.fxMobileDesc')}</div>
            </div>
            <Link className="fx-btn dl fx-mini" to="/docs" onClick={() => setInstallOpen(false)}>{t('landing.fxHow')}</Link>
          </div>

          <div className="fx-plat road">
            <span className="fx-pic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 4v4a2 2 0 0 1-2 2H4M14 4v4a2 2 0 0 0 2 2h4" /><rect x="4" y="10" width="16" height="10" rx="2" /></svg></span>
            <div className="fx-m">
              <div className="fx-t">{t('landing.fxExtTitle')} <span className="fx-chip">{t('landing.fxRoadmap')}</span></div>
              <div className="fx-d">{t('landing.fxExtDesc')}</div>
            </div>
            <a className="fx-other" href={GITHUB} target="_blank" rel="noreferrer">{t('landing.fxFollowGithub')}</a>
          </div>
        </Dialog>
      )}
    </div>
  )
}
