import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead, Dialog } from '../components'
import { useI18n } from '../i18n'
import { IS_NET } from '../api'
import { getTheme, setTheme, type Theme } from '../theme'
import '../redesign.css'
import '../landing-vault.css'

const RELEASES = 'https://github.com/deegalabs/konclave/releases'
const REPO = 'https://github.com/deegalabs/konclave'
const PLAT_META: Record<string, string> = { Windows: '.msi', macOS: '.dmg', Linux: '.deb / .AppImage' }

/** Landing — one objective: the vault, opened together. A photorealistic vault clip fills the
 *  right as a seamless loop; the pitch sits on the left. Header carries theme + download; the
 *  install modal lists every platform. Everything else lives in Docs. */
export default function Intro() {
  const { locale } = useI18n()
  const pt = locale === 'pt-BR'
  const vid = useRef<HTMLVideoElement>(null)
  const [theme, setTh] = useState<Theme>(getTheme())
  const [install, setInstall] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Honor reduced-motion: hold the poster frame instead of looping the clip.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) vid.current?.pause()
  }, [])

  const toggleTheme = () => { const n: Theme = theme === 'dark' ? 'light' : 'dark'; setTheme(n); setTh(n) }
  const createTo = IS_NET ? '/net' : '/create'

  // Auto-detect the visitor's OS so the desktop row leads with the right build.
  const os = useMemo(() => {
    const ua = navigator.userAgent
    if (/Win/i.test(ua)) return 'Windows'
    if (/Mac/i.test(ua)) return 'macOS'
    return 'Linux'
  }, [])
  const others = (['Windows', 'macOS', 'Linux'] as const).filter((p) => p !== os)

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
          <button className="lv-icon" onClick={toggleTheme} aria-pressed={theme === 'dark'} aria-label={pt ? 'Alternar tema' : 'Toggle theme'}>
            {theme === 'dark'
              ? <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
              : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></svg>}
          </button>
          <button className="lv-dl" onClick={() => setInstall(true)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
            {pt ? 'Baixar' : 'Download'}
          </button>
        </>} />
      </div>

      <main className="lv-hero">
        <div className="lv-in">
          <span className="lv-eyebrow"><span className="dot" />{pt ? 'Tesouraria Zcash coletiva · FROST' : 'Collective Zcash treasury · FROST'}</span>

          <h1>{pt
            ? <>O cofre que seu grupo <span className="em">abre junto.</span></>
            : <>The vault your group <span className="em">opens together.</span></>}</h1>

          <p className="lv-sub">{pt
            ? <>A chave nasce dividida entre os membros e nunca é remontada. Todo pagamento só sai quando o quórum aprova. <b>Privado por fora, transparente por dentro.</b></>
            : <>The key is born split across your members and never assembled. Every payment leaves only when your quorum approves it. <b>Private outside, transparent inside.</b></>}</p>

          <div className="lv-ctas">
            <Link className="lv-btn pri" to={createTo}>
              {pt ? 'Criar um cofre' : 'Create a vault'}
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
            <button className="lv-btn dl" onClick={() => setInstall(true)}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
              {pt ? 'Baixar o app' : 'Download the app'}
            </button>
            <a className="lv-demo" href="?demo=1#/vaults">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 4l14 8-14 8z" /></svg>
              {pt ? 'Ver a demo' : 'Watch the demo'}
            </a>
          </div>

          <div className="lv-trust">
            <span><b>Local-first</b> · {pt ? 'a chave nunca sai do aparelho' : 'the key never leaves the device'}</span><i />
            <span>{pt ? 'Sem telemetria' : 'No telemetry'}</span><i />
            <span>{pt ? 'Provado na mainnet' : 'Proven on mainnet'}</span><i />
            <span>Apache-2.0 / MIT</span>
          </div>

          <p className="lv-docs">{pt
            ? <>Como funciona, a arquitetura e a prova on-chain — tudo em </>
            : <>How it works, the architecture, and the on-chain proof — all in </>}
            <Link to="/docs">Docs →</Link></p>
        </div>
      </main>

      {install && (
        <Dialog labelledBy="lv-install-t" onClose={() => setInstall(false)} className="lv-ov" cardClassName="lv-card">
          <button className="lv-x" onClick={() => setInstall(false)}>✕ {pt ? 'fechar' : 'close'}</button>
          <h2 id="lv-install-t">{pt ? 'Baixe o Konclave' : 'Get Konclave'}</h2>
          <p className="lv-msub">{pt ? 'Sua parte da chave nunca sai do aparelho — em qualquer plataforma.' : 'Your key share never leaves your device — on every platform.'}</p>

          <div className="lv-plat hi">
            <span className="lv-pic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg></span>
            <div className="lv-mm">
              <div className="lv-t">{pt ? 'App web' : 'Web app'} <span className="lv-chip live">{pt ? 'no ar' : 'live'}</span></div>
              <div className="lv-d">{pt ? 'Roda no navegador. Nada pra instalar.' : 'Runs in your browser. Nothing to install.'}</div>
            </div>
            <Link className="lv-btn pri sm" to="/vaults" onClick={() => setInstall(false)}>{pt ? 'Abrir' : 'Open'}</Link>
          </div>

          <div className="lv-plat">
            <span className="lv-pic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="13" rx="1.5" /><path d="M8 20h8M12 17v3" /></svg></span>
            <div className="lv-mm">
              <div className="lv-t">{os}</div>
              <div className="lv-d">{pt ? 'Um app de janela única; nada roda na nuvem.' : 'A single-window app; nothing runs in the cloud.'}</div>
              <div className="lv-ver">v0.2.0 · {PLAT_META[os]}</div>
            </div>
            <a className="lv-btn dl sm" href={RELEASES} target="_blank" rel="noreferrer">{pt ? 'Baixar' : 'Download'}</a>
          </div>

          <button className="lv-more" onClick={() => setShowAll((s) => !s)}>{pt ? 'Outras plataformas' : 'Other platforms'} {showAll ? '▴' : '▾'}</button>
          {showAll && others.map((p) => (
            <div className="lv-plat" key={p} style={{ marginTop: 10 }}>
              <span className="lv-pic"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="2" /></svg></span>
              <div className="lv-mm">
                <div className="lv-t">{p}</div>
                <div className="lv-ver">v0.2.0 · {PLAT_META[p]}</div>
              </div>
              <a className="lv-btn dl sm" href={RELEASES} target="_blank" rel="noreferrer">{pt ? 'Baixar' : 'Download'}</a>
            </div>
          ))}

          <div className="lv-plat" style={{ marginTop: 10 }}>
            <span className="lv-pic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></svg></span>
            <div className="lv-mm">
              <div className="lv-t">{pt ? 'Celular — instale como PWA' : 'Mobile — install as PWA'}</div>
              <div className="lv-d">{pt ? 'Adicione à tela inicial. Abre como um app.' : 'Add to home screen. Opens as an app.'}</div>
            </div>
            <Link className="lv-btn dl sm" to="/docs" onClick={() => setInstall(false)}>{pt ? 'Como' : 'How'}</Link>
          </div>

          <div className="lv-plat road">
            <span className="lv-pic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 4v4a2 2 0 0 1-2 2H4M14 4v4a2 2 0 0 0 2 2h4" /><rect x="4" y="10" width="16" height="10" rx="2" /></svg></span>
            <div className="lv-mm">
              <div className="lv-t">{pt ? 'Extensão de navegador' : 'Browser extension'} <span className="lv-chip">roadmap</span></div>
              <div className="lv-d">{pt ? 'Um assinador no navegador, em andamento — ainda sem instalação.' : 'A browser signer, in progress — no install yet.'}</div>
            </div>
            <a className="lv-more" href={REPO} target="_blank" rel="noreferrer">{pt ? 'Acompanhe no GitHub →' : 'Follow on GitHub →'}</a>
          </div>
        </Dialog>
      )}
    </div>
  )
}
