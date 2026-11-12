// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Docs from './screens/Docs'
import { I18nProvider } from './i18n'

// The build takes its versions from the changelog headings (releasedVersions, no git needed). The test
// names the versions it opens instead, so the next release adds a page without changing what it checks.
vi.mock('virtual:konclave-releases', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  // @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
  const { RELEASE_SOURCES, releasePages } = await import('../../scripts/changelog-sections.mjs')
  // A path, not `new URL(template, import.meta.url)`, which Vite rewrites as an asset under jsdom.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const read = ([file]: [string, string]) => readFileSync(join(root, file), 'utf8')
  return { default: releasePages((RELEASE_SOURCES as [string, string][]).map(read), new Set(['0.19.0', '0.18.0', '0.17.0'])) }
})

// The release page as a reader meets it: built from the changelog at build time. The page's own words
// are in the reader's language and the notes in English, as the changelog is written; the issues and
// files it cites are links to GitHub.
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
  it('shows 0.18.0 dated in UTC, with its parts and categories, the notes marked as English', async () => {
    open('0.18.0', 'en')
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Konclave 0.18.0' })
    expect(h1.closest('article')!.hasAttribute('lang')).toBe(false)
    expect(screen.getAllByRole('heading', { level: 2 })[0]!.closest('[lang]')!.getAttribute('lang')).toBe('en')
    const time = document.querySelector('time')!
    expect(time.getAttribute('datetime')).toBe('2026-11-08')
    expect(time.textContent).toBe('November 8, 2026')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['The app', 'The desktop shell and shared parts'])
    expect(screen.getAllByRole('heading', { level: 3 })[0]!.textContent).toBe('Security')
  })

  it('says its own words in Portuguese, and that the notes are in English', async () => {
    open('0.18.0', 'pt-BR')
    await screen.findByRole('heading', { level: 1, name: 'Konclave 0.18.0' })
    expect(document.querySelector('.docs-eyebrow')!.textContent).toBe('Konclave · Versão')
    expect(document.querySelector('time')!.textContent).toBe('8 de novembro de 2026')
    expect(document.querySelector('.docs-lead')!.textContent).toContain('escrito em inglês')
    expect(screen.getByRole('navigation', { name: 'Versões' }).textContent).toContain('Mais antiga')
  })

  it('opens a file the notes cite by its path on GitHub, in a new tab', async () => {
    open('0.19.0')
    await screen.findByRole('heading', { level: 1 })
    const file = document.querySelector('a[href="https://github.com/deegalabs/konclave/blob/v0.19.0/helper-server/CHANGELOG.md"]')!
    expect(file.getAttribute('target')).toBe('_blank')
    expect(file.getAttribute('rel')).toBe('noopener noreferrer')
    // no link is left pointing at a path this site would open as a route
    const hrefs = [...document.querySelectorAll('article a')].map((a) => a.getAttribute('href')!)
    expect(hrefs.filter((h) => !/^(https:\/\/github\.com\/deegalabs\/konclave|\/docs\/releases\/)/.test(h))).toEqual([])
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
