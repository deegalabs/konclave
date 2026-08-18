import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import { IS_NET } from '../api'
import '../redesign.css'
import '../landing-vault.css'

/** Landing — one objective: the vault, opened together. A photorealistic vault clip fills the
 *  right as a seamless loop; the pitch sits on the left. Everything else lives in Docs. */
export default function Intro() {
  const { locale } = useI18n()
  const pt = locale === 'pt-BR'
  const vid = useRef<HTMLVideoElement>(null)

  // Honor reduced-motion: hold the poster frame instead of looping the clip.
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) vid.current?.pause()
  }, [])

  const createTo = IS_NET ? '/net' : '/create'

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
          <a className="doclink" href="https://github.com/deegalabs/konclave" target="_blank" rel="noreferrer">GitHub</a>
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
            <a className="lv-btn dl" href="https://github.com/deegalabs/konclave/releases" target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
              {pt ? 'Baixar o app' : 'Download the app'}
            </a>
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
    </div>
  )
}
