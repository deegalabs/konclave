// Theme and language, in the shell (#475).
//
// They lived in Settings, which is the vault's screen - and neither is a property of a vault. They
// are per-device app preferences, so they belong to the app chrome, reachable from anywhere instead
// of three taps into one vault's settings. #473 moved them to the bottom of that screen as the
// reversible half; this is the rest of it.
//
// Both are SEGMENTED, not a single button that flips. A flip control has to answer "does this icon
// show what I have or what I would get?", and gets it wrong for half of everyone. Two segments with
// one lit says the state and the alternative at once, and gives `aria-pressed` a real value on both.

import { useI18n } from './i18n'
import { getTheme, setTheme, type Theme } from './theme'
import { useState } from 'react'

/** Brazil, drawn rather than an emoji flag: Windows does not render regional-indicator pairs as
 *  flags at all - it shows the letters "BR" - so the emoji version breaks on the platform this is
 *  most likely to be read on. 16x11, the proportions of the real flag rounded to whole pixels. */
function FlagBR() {
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" aria-hidden="true" className="flag">
      <rect width="16" height="11" rx="1" fill="#009B3A" />
      <path d="M8 1.4 14.4 5.5 8 9.6 1.6 5.5z" fill="#FEDF00" />
      <circle cx="8" cy="5.5" r="2.5" fill="#002776" />
    </svg>
  )
}

/** The United States, simplified to what survives at 16px: the canton and alternating bars. */
function FlagUS() {
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" aria-hidden="true" className="flag">
      <rect width="16" height="11" rx="1" fill="#F5F5F5" />
      {[0, 2, 4, 6, 8, 10].map((y) => (
        <rect key={y} y={y} width="16" height="1" fill="#B22234" />
      ))}
      <rect width="7" height="6" fill="#3C3B6E" />
    </svg>
  )
}

export function LangToggle() {
  const { locale, setLocale, t } = useI18n()
  return (
    <span className="seg" role="group" aria-label={t('lang.label')}>
      {/* The code is hidden on a narrow top bar, so each button carries its own `aria-label`:
          the flag is `aria-hidden`, and a button whose only visible child disappears would be left
          with no accessible name at all. */}
      <button type="button" className={'seg-btn' + (locale === 'pt-BR' ? ' on' : '')}
        aria-pressed={locale === 'pt-BR'} aria-label={t('lang.pt')} onClick={() => setLocale('pt-BR')}>
        <FlagBR /><span className="seg-txt">{t('lang.pt')}</span>
      </button>
      <button type="button" className={'seg-btn' + (locale === 'en' ? ' on' : '')}
        aria-pressed={locale === 'en'} aria-label={t('lang.en')} onClick={() => setLocale('en')}>
        <FlagUS /><span className="seg-txt">{t('lang.en')}</span>
      </button>
    </span>
  )
}

const ico = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' } as const

function Sun() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" {...ico}>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
    </svg>
  )
}

function Moon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" {...ico}>
      <path d="M20.5 14.3A8.6 8.6 0 0 1 9.7 3.5a8.6 8.6 0 1 0 10.8 10.8z" />
    </svg>
  )
}

export function ThemeToggle() {
  const { t } = useI18n()
  const [theme, setLocal] = useState<Theme>(getTheme)
  function pick(next: Theme) {
    setTheme(next)
    setLocal(next)
  }
  return (
    <span className="seg" role="group" aria-label={t('settings.appearance')}>
      {/* Icon-only, so the accessible name carries the whole label - the segment must still say
          "Claro" / "Escuro" to anything that cannot see the sun and the moon. */}
      <button type="button" className={'seg-btn ico' + (theme === 'light' ? ' on' : '')}
        aria-pressed={theme === 'light'} aria-label={t('settings.light')} title={t('settings.light')}
        onClick={() => pick('light')}><Sun /></button>
      <button type="button" className={'seg-btn ico' + (theme === 'dark' ? ' on' : '')}
        aria-pressed={theme === 'dark'} aria-label={t('settings.dark')} title={t('settings.dark')}
        onClick={() => pick('dark')}><Moon /></button>
    </span>
  )
}

/** Both, as one cluster for the shell. */
export default function AppPrefs() {
  return (
    <div className="rail-prefs">
      <ThemeToggle />
      <LangToggle />
    </div>
  )
}
