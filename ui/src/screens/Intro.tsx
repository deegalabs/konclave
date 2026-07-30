import { type ReactNode, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead } from '../components'
import { useT, useTr, useI18n } from '../i18n'
import '../redesign.css'
import '../landing.css'

// A single directory of every live surface, so a first-time visitor (or a judge) finds
// them all in one place instead of dispersed across the app. Bilingual inline.
const EXPLORE: Record<'pt-BR' | 'en', { eyebrow: string; title: string; items: { to: string; name: string; desc: string; tag?: string }[] }> = {
  'pt-BR': {
    eyebrow: 'EXPLORE',
    title: 'Tudo pra experimentar, num lugar só',
    items: [
      { to: '/vaults', name: 'Abrir o cofre', desc: 'O produto rodando: pagamento, folha, aprovações e registro.', tag: 'app' },
      { to: '/proof', name: 'Comprovação na blockchain', desc: 'Confira você mesmo, no explorador público, as transações reais do Konclave na mainnet.', tag: 'prova' },
      { to: '/net', name: 'Cofre entre dispositivos', desc: 'Crie e opere o mesmo cofre no celular e no computador. Nenhum servidor vê um segredo.' },
      { to: '/signer', name: 'Assinar no navegador', desc: 'Veja uma assinatura de quórum acontecer inteira dentro do navegador.', tag: 'demo' },
      { to: '/recovery', name: 'Recuperação de membro', desc: 'Um quórum reconstrói a parte de quem perdeu acesso, sem expor a chave.' },
      { to: '/inheritance', name: 'Herança', desc: 'Se um responsável some, o quórum libera os fundos a um herdeiro.' },
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
      { to: '/signer', name: 'Sign in the browser', desc: 'Watch a quorum signature happen entirely inside the browser.', tag: 'demo' },
      { to: '/recovery', name: 'Member recovery', desc: 'A quorum rebuilds the share of whoever lost access, without exposing the key.' },
      { to: '/inheritance', name: 'Inheritance', desc: 'If a steward disappears, the quorum releases the funds to an heir.' },
      { to: '/docs', name: 'Documentation', desc: 'How it works, the architecture and the diagrams.' },
    ],
  },
}

/** Landing / explainer — the "why" surface and the app's front door. */
export default function Intro() {
  const t = useT()
  const tr = useTr()
  const { locale } = useI18n()
  const ex = EXPLORE[locale === 'pt-BR' ? 'pt-BR' : 'en']
  const scrollTo = (id: string) => (e: MouseEvent) => {
    e.preventDefault()
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
  }

  const pillars: Array<{ icon: ReactNode; title: string; desc: string }> = [
    {
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5z" /><path d="M9 12l2 2 4-4" /></svg>,
      title: t('landing.pillar1Title'), desc: 'landing.pillar1Desc',
    },
    {
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>,
      title: t('landing.pillar2Title'), desc: 'landing.pillar2Desc',
    },
    {
      icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h10" /></svg>,
      title: t('landing.pillar3Title'), desc: 'landing.pillar3Desc',
    },
  ]

  return (
    <div className="rd lp">
      {/* top bar — shared Letterhead so the landing opens like every other screen */}
      <div className="lp-wrap">
        <Letterhead right={<>
          <Link to="/proof" className="doclink">{t('landing.navProof')}</Link>
          <Link to="/net" className="doclink">{t('landing.navNet')}</Link>
          <Link to="/signer" className="doclink">{t('landing.navSigner')}</Link>
          <Link to="/docs" className="doclink">Docs</Link>
          <span className="lp-env">{tr('landing.env')}</span>
        </>} />
      </div>

      {/* hero */}
      <div className="lp-wrap">
        <div className="lp-hero">
          <svg className="seal" viewBox="0 0 96 96" fill="none" aria-hidden="true">
            <circle cx="48" cy="48" r="45" stroke="var(--accent)" strokeWidth="1" />
            <circle cx="48" cy="48" r="39" stroke="var(--accent)" strokeWidth="2.4" />
            <circle cx="48" cy="48" r="34" stroke="var(--silver)" strokeWidth=".6" strokeDasharray="1 3" />
            <g stroke="var(--silver)" strokeWidth=".7" opacity=".55"><circle cx="48" cy="48" r="30" />
              <path d="M48 18c9 12 9 48 0 60M48 18c-9 12-9 48 0 60M18 48c12-9 48-9 60 0M18 48c12 9 48 9 60 0" /></g>
          </svg>
          <span className="eyebrow">{t('landing.eyebrow')}</span>
          <h1>{t('landing.h1')}</h1>
          <p className="sub">{tr('landing.sub')}</p>
          <div className="lp-ctas">
            <Link className="lp-btn primary" to="/demo">
              {t('demo.watchCta')}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
            <Link className="lp-btn" to="/docs">{t('landing.ctaHow')}</Link>
            <Link className="lp-btn" to="/vaults">{t('landing.ctaVaults')}</Link>
          </div>
          <span className="trust"><i />{t('landing.heroTrust')}</span>
        </div>
      </div>

      {/* explore — one directory of every live surface */}
      <section className="lp-section lp-explore" id="lp-explore" style={{ paddingTop: 8 }}>
        <div className="lp-wrap">
          <span className="eyebrow sec-eyebrow">{ex.eyebrow}</span>
          <h2 className="lp-title">{ex.title}</h2>
          <div className="lp-explore-grid">
            {ex.items.map((it) => (
              <Link key={it.to} to={it.to} className="lp-explore-card">
                <span className="lp-ex-head">
                  <span className="lp-ex-name">{it.name}</span>
                  {it.tag && <span className="lp-ex-tag">{it.tag}</span>}
                </span>
                <span className="lp-ex-desc">{it.desc}</span>
                <span className="lp-ex-go" aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* why */}
      <section className="lp-section" id="lp-porque">
        <div className="lp-wrap">
          <span className="eyebrow sec-eyebrow">{t('landing.whyEyebrow')}</span>
          <h2 className="lp-title">{t('landing.whyTitle')}</h2>
          <p className="lp-lead">{t('landing.whyLead')}</p>

          <div className="lp-pillars">
            {pillars.map((p) => (
              <div className="lp-pillar" key={p.title}>
                <span className="ic">{p.icon}</span>
                <h3>{p.title}</h3>
                <p>{tr(p.desc)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* killer use case */}
      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-wrap">
          <div className="lp-killer">
            <div>
              <span className="eyebrow">{t('landing.killerEyebrow')}</span>
              <h3>{t('landing.killerTitle')}</h3>
              <p>{tr('landing.killerDesc')}</p>
            </div>
            <div className="lp-slip" aria-hidden="true">
              <div className="ph"><span>{t('landing.killerSlipTitle')}</span><span>{t('landing.killerSlipCount')}</span></div>
              {['Ana R.', 'Bruno S.', 'Carla N.', 'Diego F.', 'Elis P.'].map((who) => (
                <div className="prow" key={who}><span>{who}</span><span className="amt">0.0600</span></div>
              ))}
              <div className="tot"><span>{t('landing.killerSlipFoot')}</span><b>{t('landing.killerSlipApproved')}</b></div>
            </div>
          </div>
        </div>
      </section>

      {/* trust band */}
      <div className="lp-trust">
        <div className="lp-wrap">
          <div className="lp-trust-inner">
            <svg className="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5z" /><path d="M9 12l2 2 4-4" /></svg>
            <div>
              <span className="klab">{t('landing.trustEyebrow')}</span>
              <h3>{t('landing.trustTitle')}</h3>
              <p>{locale === 'pt-BR'
                ? 'Criptografia da Zcash Foundation. Local-first, sem telemetria: seus segredos nunca saem do dispositivo.'
                : 'Cryptography by the Zcash Foundation. Local-first, no telemetry: your secrets never leave the device.'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* final cta */}
      <section className="lp-section lp-final">
        <div className="lp-wrap">
          <h2>{t('landing.finalTitle')}</h2>
          <p>{t('landing.finalDesc')}</p>
          <div className="lp-ctas">
            <Link className="lp-btn primary" to="/create">
              {t('landing.finalCtaCreate')}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </Link>
            <a className="lp-btn" href="#lp-porque" onClick={scrollTo('lp-porque')}>{t('landing.finalCtaWhy')}</a>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap">
          <div>{tr('landing.footer1')}<br />{t('landing.footer2')}</div>
        </div>
      </footer>
    </div>
  )
}
