import { type ReactNode, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { useT, useTr } from '../i18n'
import '../redesign.css'
import '../landing.css'

/** Landing / explainer — the "why" surface and the app's front door. */
export default function Intro() {
  const t = useT()
  const tr = useTr()
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

  const cmpRows: Array<[string, string, string, string]> = [
    [t('landing.cmpBank'), 'no', 'no', 'yes'],
    [t('landing.cmpMultisig'), 'yes', 'no', 'mid'],
    [t('landing.cmpCli'), 'yes', 'yes', 'no'],
    [t('landing.cmpSheet'), 'no', 'mid', 'yes'],
  ]
  const mark = (s: string) => (s === 'yes' ? '✓' : s === 'no' ? '✕' : '~')

  const steps = [
    { n: 1, title: t('landing.step1Title'), desc: 'landing.step1Desc' },
    { n: 2, title: t('landing.step2Title'), desc: 'landing.step2Desc' },
    { n: 3, title: t('landing.step3Title'), desc: 'landing.step3Desc' },
  ]

  return (
    <div className="rd lp">
      {/* top bar */}
      <div className="lp-wrap">
        <header className="lp-top">
          <Link to="/intro" className="lp-brand">
            <svg width="30" height="30" viewBox="0 0 44 44" fill="none" aria-hidden="true">
              <circle cx="22" cy="22" r="20.5" stroke="var(--line-strong)" /><circle cx="22" cy="22" r="15" stroke="var(--accent)" strokeOpacity=".55" />
              <circle cx="22" cy="22" r="6.4" fill="var(--accent)" fillOpacity=".14" stroke="var(--accent)" /><circle cx="22" cy="22" r="2" fill="var(--accent)" />
            </svg>
            <span className="wm">KONCLAVE</span>
          </Link>
          <span className="lp-env">{tr('landing.env')}</span>
        </header>
      </div>

      {/* hero */}
      <div className="lp-wrap">
        <div className="lp-hero">
          <svg className="seal" viewBox="0 0 96 96" fill="none" aria-hidden="true">
            <circle cx="48" cy="48" r="45" stroke="#57a6ff" strokeWidth="1" />
            <circle cx="48" cy="48" r="39" stroke="#57a6ff" strokeWidth="2.4" />
            <circle cx="48" cy="48" r="34" stroke="#c6cfd9" strokeWidth=".6" strokeDasharray="1 3" />
            <g stroke="#8ba7c9" strokeWidth=".7" opacity=".8"><circle cx="48" cy="48" r="30" />
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
            <a className="lp-btn" href="#lp-como" onClick={scrollTo('lp-como')}>{t('landing.ctaHow')}</a>
            <Link className="lp-btn" to="/vaults">{t('landing.ctaVaults')}</Link>
          </div>
          <span className="trust"><i />{t('landing.heroTrust')}</span>
        </div>
      </div>

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

          <div className="lp-compare">
            <div className="lp-cscroll">
              <table className="lp-cmp">
                <thead><tr>
                  <th>{t('landing.cmpAlt')}</th>
                  <th className="col">{t('landing.cmpCol1')}</th>
                  <th className="col">{t('landing.cmpCol2')}</th>
                  <th className="col">{t('landing.cmpCol3')}</th>
                </tr></thead>
                <tbody>
                  {cmpRows.map(([name, a, b, c]) => (
                    <tr key={name}>
                      <td className="name">{name}</td>
                      <td className={'mk ' + a}>{mark(a)}</td>
                      <td className={'mk ' + b}>{mark(b)}</td>
                      <td className={'mk ' + c}>{mark(c)}</td>
                    </tr>
                  ))}
                  <tr className="kon">
                    <td className="name">{t('landing.cmpKon')}</td>
                    <td className="mk yes">✓</td><td className="mk yes">✓</td><td className="mk yes">✓</td>
                  </tr>
                </tbody>
              </table>
            </div>
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

      {/* how it works */}
      <section className="lp-section" id="lp-como">
        <div className="lp-wrap">
          <span className="eyebrow sec-eyebrow">{t('landing.howEyebrow')}</span>
          <h2 className="lp-title">{t('landing.howTitle')}</h2>
          <div className="lp-steps">
            {steps.map((s) => (
              <div className="lp-step" key={s.n}>
                <span className="n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{tr(s.desc)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* where it's going */}
      <section className="lp-section" style={{ paddingTop: 0 }}>
        <div className="lp-wrap">
          <span className="eyebrow sec-eyebrow">{t('landing.roadEyebrow')}</span>
          <h2 className="lp-title">{t('landing.roadTitle')}</h2>
          <p className="lp-lead">{tr('landing.roadLead')}</p>
          <div className="lp-road">
            <div className="lp-phase now">
              <div className="ptop"><span className="plabel">{t('landing.roadNowLabel')}</span><span className="pbadge ok">{t('landing.roadNowBadge')}</span></div>
              <h3>{t('landing.roadNowTitle')}</h3>
              <p>{tr('landing.roadNowDesc')}</p>
            </div>
            <span className="lp-road-arrow" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </span>
            <div className="lp-phase next">
              <div className="ptop"><span className="plabel">{t('landing.roadNextLabel')}</span><span className="pbadge accent">{t('landing.roadNextBadge')}</span></div>
              <h3>{t('landing.roadNextTitle')}</h3>
              <p>{tr('landing.roadNextDesc')}</p>
            </div>
          </div>
          <p className="lp-road-note">{t('landing.roadNote')}</p>
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
              <p>{tr('landing.trustDesc')}</p>
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
