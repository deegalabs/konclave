// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Docs from './screens/Docs'
import { I18nProvider } from './i18n'

// The release page as a reader meets it: built from the changelog at build time, in English whatever
// the app's language, with the issue numbers it cites as links.
const open = (version: string, locale = 'pt-BR') => {
  localStorage.setItem('konclave.locale', locale)
  return render(
    <MemoryRouter initialEntries={[`/docs/releases/${version}`]}>
      <I18nProvider>
        <Routes>
          <Route path="/docs/releases/:version" element={<Docs />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('a release page', () => {
  it('shows 0.18.0 in English, dated in UTC, with its parts and categories', async () => {
    open('0.18.0')
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Konclave 0.18.0' })
    expect(h1.closest('article')!.getAttribute('lang')).toBe('en')
    const time = document.querySelector('time')!
    expect(time.getAttribute('datetime')).toBe('2026-11-08')
    expect(time.textContent).toBe('November 8, 2026')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['The app', 'The desktop shell and shared parts'])
    expect(screen.getAllByRole('heading', { level: 3 })[0]!.textContent).toBe('Security')
  })

  it('links each issue it cites to GitHub, as the roadmap does', async () => {
    open('0.18.0')
    await screen.findByRole('heading', { level: 1 })
    const ref = document.querySelector('a[href="https://github.com/deegalabs/konclave/issues/813"]')!
    expect(ref.className).toBe('docs-ref-chip')
    expect(ref.textContent).toBe('#813 (GitHub, new tab)')
    // No local title for it, so no card that would have nothing to say.
    expect(ref.closest('.docs-ref')!.querySelector('.docs-ref-card')).toBeNull()
  })

  it('marks no docs section as the current page', async () => {
    open('0.18.0')
    await screen.findByRole('heading', { level: 1 })
    expect(document.querySelector('[aria-current="page"]')).toBeNull()
  })

  it('says so for a version that was never released', async () => {
    open('9.9.9', 'en')
    expect(await screen.findByRole('heading', { level: 1, name: 'No release 9.9.9' })).toBeTruthy()
  })
})
