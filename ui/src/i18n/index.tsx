// Minimal, dependency-free i18n for the UI. English keys; per-locale value dictionaries.
// Portuguese-first (the target treasurer audience), English available via the toggle.
// Local-first friendly: no network, no telemetry — just two static dictionaries.

import { createContext, Fragment, useCallback, useContext, useState, type ReactNode } from 'react'
import { en } from './en'
import { ptBR } from './pt-BR'

export type Locale = 'en' | 'pt-BR'
type Dict = Record<string, string>

const DICTS: Record<Locale, Dict> = { en, 'pt-BR': ptBR }
const LOCALE_KEY = 'konclave.locale'

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved === 'en' || saved === 'pt-BR') return saved
    // No saved choice: Portuguese browsers get PT, everyone else (e.g. international judges)
    // gets English. The toggle overrides and persists either way.
    if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('pt')) {
      return 'pt-BR'
    }
  } catch { /* storage unavailable */ }
  return 'en'
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string

/** Substitute `{name}` placeholders in a translated string. Pure (no locale state) so it
 *  can be unit-tested directly. Unknown placeholders are left untouched. */
export function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
  return s
}

type I18n = { locale: Locale; setLocale: (l: Locale) => void; t: TFn }
const Ctx = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try { localStorage.setItem(LOCALE_KEY, l) } catch { /* storage unavailable */ }
  }, [])

  const t = useCallback<TFn>((key, vars) => {
    // Fall back to English, then to the raw key, so a missing translation is never a blank.
    const s = DICTS[locale][key] ?? DICTS.en[key] ?? key
    return interpolate(s, vars)
  }, [locale])

  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>
}

export function useI18n(): I18n {
  const c = useContext(Ctx)
  if (!c) throw new Error('useI18n must be used within <I18nProvider>')
  return c
}

/** Convenience hook for components that only need the translate function. */
export function useT(): TFn {
  return useI18n().t
}

/** Render a translated string, turning **double-asterisk** runs into <b>…</b>.
 *  Lets copy with inline emphasis stay a single readable dictionary value. */
function renderBold(s: string): ReactNode {
  // Each line may contain **bold** runs; blank-line-free \n becomes a <br/>.
  const lines = s.split('\n')
  return lines.map((line, li) => (
    <Fragment key={li}>
      {li > 0 && <br />}
      {line.split('**').map((seg, i) => (i % 2 === 1 ? <b key={i}>{seg}</b> : <Fragment key={i}>{seg}</Fragment>))}
    </Fragment>
  ))
}

export type TRichFn = (key: string, vars?: Record<string, string | number>) => ReactNode

/** Like useT, but returns a ReactNode with **bold** markers rendered as <b>. */
export function useTr(): TRichFn {
  const t = useT()
  return useCallback<TRichFn>((key, vars) => renderBold(t(key, vars)), [t])
}
