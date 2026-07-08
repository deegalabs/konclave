import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Mark } from '../components'
import { useT, useTr } from '../i18n'
import '../redesign.css'

/** The logo lockup with a graceful fallback to the SVG mark. */
function IntroLogo() {
  const [failed, setFailed] = useState(false)
  if (failed) return <Mark />
  return (
    <img className="rd-lockup intro-logo" src={`${import.meta.env.BASE_URL}logo.png`} alt="Konclave"
      onError={() => setFailed(true)} />
  )
}

export default function Intro() {
  const t = useT()
  const tr = useTr()
  const CARDS: Array<{ ic: string; t: string; d: string }> = [
    { ic: '🖥️', t: t('intro.card1Title'), d: t('intro.card1Desc') },
    { ic: '🤝', t: t('intro.card2Title'), d: t('intro.card2Desc') },
    { ic: '🛡️', t: t('intro.card3Title'), d: t('intro.card3Desc') },
  ]
  return (
    <div className="rd">
      <div className="rd-shell intro">
        <div className="intro-hero">
          <IntroLogo />
          <span className="rd-eyebrow">{t('intro.eyebrow')}</span>
          <h1>{tr('intro.heroTitle')}</h1>
          <p>{tr('intro.lead')}</p>
        </div>

        <div className="intro-cards">
          {CARDS.map((c) => (
            <div className="intro-card" key={c.t}>
              <div className="intro-ic">{c.ic}</div>
              <div className="intro-t">{c.t}</div>
              <div className="intro-d">{c.d}</div>
            </div>
          ))}
        </div>

        <div className="intro-cta">
          <Link className="rd-enter primary" to="/">{t('intro.cta')} <span className="arw">→</span></Link>
        </div>

        <div className="rd-note">{tr('intro.note')}</div>
      </div>
    </div>
  )
}
