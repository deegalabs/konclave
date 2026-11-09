// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import Docs from './screens/Docs'
import { I18nProvider } from './i18n'

// A build makes pages only for the versions it sees tagged, and CI's checkout has no tags (#573), so
// the test states which were released, as release-notes-shared.test.ts does.
vi.mock('virtual:konclave-releases', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  // @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
  const { RELEASE_SOURCES, releasePages } = await import('../../scripts/changelog-sections.mjs')
  // A path, not `new URL(template, import.meta.url)`, which Vite rewrites as an asset under jsdom.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const read = ([file]: [string, string]) => readFileSync(join(root, file), 'utf8')
  return { default: releasePages((RELEASE_SOURCES as [string, string][]).map(read), new Set(['0.18.0', '0.17.0'])) }
})

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
