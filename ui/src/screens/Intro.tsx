import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Mark } from '../components'
import { useT, useTr } from '../i18n'
import '../redesign.css'

// Line icons (no emoji — the self-hosted fonts ship none, and the brand bans them).
const svg = (children: ReactNode) => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconDevice = svg(<><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></>)
const IconQuorum = svg(<><circle cx="9" cy="12" r="5.5" /><circle cx="15" cy="12" r="5.5" /></>)
const IconShield = svg(<><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></>)

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
  const CARDS: Array<{ ic: ReactNode; t: string; d: string }> = [
    { ic: IconDevice, t: t('intro.card1Title'), d: t('intro.card1Desc') },
    { ic: IconQuorum, t: t('intro.card2Title'), d: t('intro.card2Desc') },
    { ic: IconShield, t: t('intro.card3Title'), d: t('intro.card3Desc') },
  ]
  return (
    <div className="rd">
      <main className="rd-shell intro">
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
      </main>
    </div>
  )
}
