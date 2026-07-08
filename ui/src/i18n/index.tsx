// Minimal, dependency-free i18n for the UI. English keys; per-locale value dictionaries.
// Portuguese-first (the target treasurer audience), English available via the toggle.
// Local-first friendly: no network, no telemetry — just two static dictionaries.

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
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
  } catch { /* storage unavailable */ }
  return 'pt-BR'
}

export type TFn = (key: string, vars?: Record<string, string | number>) => string

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
    let s = DICTS[locale][key] ?? DICTS.en[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
    return s
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
