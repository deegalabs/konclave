import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead, Dialog, Soon } from '../components'
import { useT, useTr } from '../i18n'
import { getTheme, setTheme, type Theme } from '../theme'
import '../redesign.css'
import '../landing-vault.css'
import { useInstall } from '../use-install'
import { DESKTOP_VERSION } from '../desktop-release'
import { VersionBadge } from '../UpdatePrompt'

const REPO = 'https://github.com/deegalabs/konclave'
const RELEASES = `${REPO}/releases`
const VER = DESKTOP_VERSION
// Kept, unused for now: the installers exist at these URLs and the buttons go live again the
// moment per-platform validation lands (#212). Deleting it would lose the mapping.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const dl = (file: string) => `${REPO}/releases/download/v${VER}/${file}`
void dl
// One-click installers → the real assets of release VER (GitHub serves them as attachments, so the
// click downloads directly). macOS ships Apple Silicon only; there is no Intel build. The .deb,
// .rpm and .exe live under RELEASES. None of them is code-signed or notarized yet.
const BUILDS = {
  Windows: { ext: '.msi', file: `Konclave_${VER}_x64_en-US.msi` },
  macOS: { ext: '.dmg (Apple Silicon)', file: `Konclave_${VER}_aarch64.dmg` },
  Linux: { ext: '.AppImage', file: `Konclave_${VER}_amd64.AppImage` },
}
type OS = keyof typeof BUILDS

/** Landing - one objective: the vault, opened together. A photorealistic vault clip fills the
 *  right as a seamless loop; the pitch sits on the left. Header carries theme + download; the
 *  install modal lists every platform. Everything else lives in Docs. */
export default function Intro() {
  // The landing predates the dictionary and carried its own bilingual copy; it reads the
  // dictionary now like every other screen, so the parity test sees it (#318).
  const t = useT()
  const tr = useTr()
  const soonWhy = t('lv.soonWhy', { ver: VER })
  const vid = useRef<HTMLVideoElement>(null)
  const [theme, setTh] = useState<Theme>(getTheme())
  const [install, setInstall] = useState(false)
  const { offer, promptInstall } = useInstall()
  const [showAll, setShowAll] = useState(false)

  // Honor reduced-motion: hold the poster frame instead of looping the clip.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) vid.current?.pause()
  }, [])

  const toggleTheme = () => { const n: Theme = theme === 'dark' ? 'light' : 'dark'; setTheme(n); setTh(n) }

  // Auto-detect the visitor's OS so the desktop row leads with the right build.
  const os = useMemo<OS>(() => {
    const ua = navigator.userAgent
    if (/Win/i.test(ua)) return 'Windows'
    if (/Mac/i.test(ua)) return 'macOS'
    return 'Linux'
  }, [])
  const others = (Object.keys(BUILDS) as OS[]).filter((p) => p !== os)

  return (
    <div className="lv">
      <video
        ref={vid}
        className="lv-bg"
        autoPlay
        loop
        muted
        playsInline
        poster="/videos/konclave-hero-poster.jpg"
        aria-hidden="true"
      >
        <source src="/videos/konclave-hero-loop.mp4" type="video/mp4" />
      </video>
      <div className="lv-scrim" aria-hidden="true" />

      <div className="lv-head">
        <Letterhead right={<>
          <Link to="/docs" className="doclink">Docs</Link>
          <a className="doclink" href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          <button className="lv-icon" onClick={toggleTheme} aria-pressed={theme === 'dark'} aria-label={t('lv.toggleTheme')}>
            {theme === 'dark'
              ? <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
              : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></svg>}
          </button>
          {/* On a narrow phone this collapses to the icon alone (landing-vault.css), so the
              label lives in its own element and the button carries the name for both shapes. */}
          <button className="lv-dl" onClick={() => setInstall(true)} aria-label={t('lv.download')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
            <span className="lv-dl-t">{t('lv.download')}</span>
          </button>
        </>} />
      </div>

      <main className="lv-hero">
        <div className="lv-in">
          <span className="lv-eyebrow"><span className="dot" />{t('lv.eyebrow')}</span>

          <h1>{t('lv.h1')} <span className="em">{t('lv.h1em')}</span></h1>

          <p className="lv-sub">{tr('lv.sub')}</p>

          <div className="lv-ctas">
            <Link className="lv-btn pri" to="/vaults">
              {t('lv.create')}
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
            <button className="lv-btn dl" onClick={() => setInstall(true)}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
              {t('lv.downloadApp')}
            </button>
          </div>

          <div className="lv-trust">
            <span>{tr('lv.trust1')}</span><i />
            <span>{tr('lv.trust2')}</span><i />
            <span>{tr('lv.trust3')}</span><i />
            <span>{tr('lv.trust4')}</span>
          </div>

          <p className="lv-docs">{t('lv.docsLead')} <Link to="/docs">Docs →</Link></p>
          <p className="lv-docs"><VersionBadge /></p>
        </div>
      </main>

      {install && (
        <Dialog labelledBy="lv-install-t" onClose={() => setInstall(false)} className="lv-ov" cardClassName="lv-card">
          <button className="lv-x" onClick={() => setInstall(false)}>✕ {t('lv.close')}</button>
          <h2 id="lv-install-t">{t('lv.getTitle')}</h2>
          <p className="lv-msub">{t('lv.getSub')}</p>

          {/* The web line used to end at "nothing to install", which on a phone is the opposite of
              true: the app IS installable and this dialog is where the offer belongs. What can be
              offered differs by platform, so the line changes with it (#382). */}
          <div className="lv-plat hi">
            <span className="lv-pic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg></span>
            <div className="lv-mm">
              <div className="lv-t">{t('lv.web')} <span className="lv-chip live">{t('lv.live')}</span></div>
              <div className="lv-d">{offer.kind === 'none'
                ? t('lv.webNoInstall')
                : t('lv.webInstallable')}</div>
              {offer.kind === 'prompt' && (
                <button type="button" className="lv-btn dl sm lv-inst" onClick={() => void promptInstall()}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
                  {t('lv.installHere')}
                </button>
              )}
              {offer.kind === 'ios' && (
                <div className="lv-ver lv-inst-hint">{t('lv.iosHint')}</div>
              )}
              {offer.kind === 'installed' && (
                <div className="lv-ver lv-inst-hint">{t('lv.installed')}</div>
              )}
            </div>
            <Link className="lv-btn pri sm" to="/vaults" onClick={() => setInstall(false)}>{t('lv.open')}</Link>
          </div>

          <div className="lv-plat">
            <span className="lv-pic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="13" rx="1.5" /><path d="M8 20h8M12 17v3" /></svg></span>
            <div className="lv-mm">
              <div className="lv-t">{os}</div>
              <div className="lv-d">{t('lv.desktopDesc')}</div>
              <div className="lv-ver">v{VER} · {BUILDS[os].ext}</div>
            </div>
            {/* The desktop line is built (a pre-release, DESKTOP_VERSION; not code-signed or notarized) but
                not yet validated per platform (#212, ADR-0004). Offering an untested installer for
                a tool that holds money is a worse promise than saying "not yet" - so the option
                stays visible and inert. */}
            <Soon reason={soonWhy}>
              <span className="lv-btn dl sm">{t('lv.download')}</span>
            </Soon>
          </div>

          <button className="lv-more" onClick={() => setShowAll((s) => !s)}>{t('lv.otherPlatforms')} {showAll ? '▴' : '▾'}</button>
          {showAll && (
            <>
              {others.map((p) => (
                <div className="lv-plat" key={p} style={{ marginTop: 10 }}>
                  <span className="lv-pic"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="2" /></svg></span>
                  <div className="lv-mm">
                    <div className="lv-t">{p}</div>
                    <div className="lv-ver">v{VER} · {BUILDS[p].ext}</div>
                  </div>
                  <Soon reason={soonWhy}>
                    <span className="lv-btn dl sm">{t('lv.download')}</span>
                  </Soon>
                </div>
              ))}
              <a className="lv-more" href={RELEASES} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 4 }}>
                {t('lv.allBuilds')}
              </a>
            </>
          )}

          <div className="lv-plat" style={{ marginTop: 10 }}>
            <span className="lv-pic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></svg></span>
            <div className="lv-mm">
              <div className="lv-t">{t('lv.mobile')}</div>
              <div className="lv-d">{t('lv.mobileDesc')}</div>
            </div>
            <Link className="lv-btn dl sm" to="/docs/faq" onClick={() => setInstall(false)}>{t('lv.how')}</Link>
          </div>

          <div className="lv-plat road">
            <span className="lv-pic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 4v4a2 2 0 0 1-2 2H4M14 4v4a2 2 0 0 0 2 2h4" /><rect x="4" y="10" width="16" height="10" rx="2" /></svg></span>
            <div className="lv-mm">
              <div className="lv-t">{t('lv.extension')} <span className="lv-chip">roadmap</span></div>
              <div className="lv-d">{t('lv.extensionDesc')}</div>
            </div>
            <a className="lv-more" href={REPO} target="_blank" rel="noreferrer">{t('lv.github')}</a>
          </div>
        </Dialog>
      )}
    </div>
  )
}
