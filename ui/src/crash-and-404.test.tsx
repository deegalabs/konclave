import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider, translateStatic } from './i18n'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import NotFound from './screens/NotFound'
import { CrashScreen } from './ErrorBoundary'
import { codeOf } from './source-scan'

// #318: a member's worst moment (a dead link, a crashed screen) was English-only. Both screens
// now read the dictionary; the crash screen without React context, since the boundary is a class
// and the provider above it may be part of what crashed.
describe("the 404 and the crash screen speak the member's language (#318)", () => {
  it('the crash screen renders in each language, with no provider at all', () => {
    const pt = renderToStaticMarkup(<CrashScreen locale="pt-BR" />)
    expect(pt).toContain(ptBR['crash.title'])
    expect(pt).toContain(ptBR['crash.reload'])
    const enHtml = renderToStaticMarkup(<CrashScreen locale="en" />)
    expect(enHtml).toContain(en['crash.title'])
    expect(enHtml).not.toContain(ptBR['crash.title'])
  })

  it('the 404 renders from the dictionary', () => {
    const html = renderToStaticMarkup(<I18nProvider><NotFound /></I18nProvider>)
    expect(html).toContain(en['notFound.title']) // no saved choice and no browser: English
    expect(html).toContain('#/vaults')
  })

  it('translateStatic falls back to English, then to the key', () => {
    expect(translateStatic('crash.label', undefined, 'pt-BR')).toBe(ptBR['crash.label'])
    expect(translateStatic('no.such.key', undefined, 'pt-BR')).toBe('no.such.key')
  })

  it('neither screen carries English copy of its own any more', () => {
    for (const f of ['./screens/NotFound.tsx', './ErrorBoundary.tsx']) {
      const src = codeOf(f)
      expect(src, f).not.toMatch(/My vaults|>Reload<|not found|Something broke/)
      expect(src, f).toMatch(/from '\.\.?\/i18n'/)
    }
  })
})
