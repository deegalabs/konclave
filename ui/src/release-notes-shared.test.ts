import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { RELEASE_SOURCES, notesBlocks, releaseBody, releaseBodyFor, releasePages, semverCompare } from '../../scripts/changelog-sections.mjs'

type Block = { k: string; t?: string; items?: string[] }
type Page = { version: string; date: string; blocks: Block[] }

// The docs' release pages are built from the same function that writes the GitHub release body, so a
// release is never written twice. These pin the conversion, and that every release has a page.
const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8')
const mds = (RELEASE_SOURCES as [string, string][]).map(([file]) => read(file))
// What was released is a fact about the repository's history, so the tests state it rather than
// read the machine's tags (#573): every version tagged up to 0.18.0, except 0.9.0 and 0.5.0, which
// were cut and superseded before they shipped.
const RELEASED = new Set(['0.18.0', '0.17.0', '0.16.0', '0.15.0', '0.14.0', '0.13.2', '0.13.1', '0.13.0', '0.12.0',
  '0.11.0', '0.10.0', '0.8.0', '0.7.0', '0.6.0', '0.4.0', '0.3.0', '0.2.0', '0.1.0'])
const entries = (blocks: Block[]) => blocks.reduce((n, b) => n + (b.items?.length ?? 0), 0)

describe('notesBlocks', () => {
  it('turns headings, entries, notes and paragraphs into blocks', () => {
    const body = [
      '## The app',
      '',
      '### Security',
      '',
      '- **One.** First line',
      '  continued here.',
      '- **Two.** Alone.',
      '',
      '> A note',
      '> on two lines.',
      '',
      'A paragraph',
      'that wraps.',
    ].join('\n')
    expect(notesBlocks(body)).toEqual([
      { k: 'h', t: 'The app' },
      { k: 'h3', t: 'Security' },
      { k: 'ul', items: ['**One.** First line continued here.', '**Two.** Alone.'] },
      { k: 'note', t: 'A note on two lines.' },
      { k: 'p', t: 'A paragraph that wraps.' },
    ])
  })

  it('starts a new list after a blank line', () => {
    expect(notesBlocks('- a\n\n- b').map((b: Block) => b.items)).toEqual([['a'], ['b']])
  })
})

describe('releaseBody', () => {
  it('labels the parts only when more than one has something to say', () => {
    expect(releaseBody([['The app', '- a'], ['The shell', '']])).toBe('- a')
    expect(releaseBody([['The app', '- a'], ['The shell', '- b']])).toBe('## The app\n\n- a\n\n## The shell\n\n- b')
    expect(releaseBody([['The app', ''], ['The shell', '']])).toBe('')
  })

  it('puts an upgrade instruction first, as the GitHub release does', () => {
    const body = releaseBody([['The app', '### Changed\n\n- **Upgrading from 0.1:** do this first.']])
    expect(body.startsWith('**Upgrading from 0.1:** do this first.\n\n### Changed')).toBe(true)
  })

  it('puts it first when it is in the second of two parts, as in 0.17.0', () => {
    const body = releaseBody([['The app', '- a'], ['The shell', '### Changed\n\n- **Upgrading from 0.16:** do this first.']])
    expect(body.startsWith('**Upgrading from 0.16:** do this first.\n\n## The app')).toBe(true)
  })
})

describe('releaseBodyFor', () => {
  it('folds in the sections cut beneath a release and never tagged, as the GitHub release does', () => {
    // 0.9.0 was superseded by 0.10.0, and 0.5.0 by 0.6.0: each release carried both sections.
    expect(entries(notesBlocks(releaseBodyFor('0.10.0', mds, RELEASED)))).toBe(37)
    expect(entries(notesBlocks(releaseBodyFor('0.6.0', mds, RELEASED)))).toBe(42)
  })

  it('reports the version alone when it cannot tell what was released', () => {
    expect(entries(notesBlocks(releaseBodyFor('0.10.0', mds, null)))).toBe(16)
  })

  it('does not fill a changelog with no section for a released version from its [Unreleased]', () => {
    // The app's changelog starts at 0.5.0; before this, 0.1.0-0.4.0 printed its [Unreleased].
    const body = releaseBodyFor('0.4.0', mds, RELEASED)
    expect(body).not.toContain('## The app')
    expect(body.startsWith('### Security')).toBe(true)
  })
})

describe('the release pages, from the real changelogs', () => {
  const pages: Page[] = releasePages(mds, RELEASED)

  it('gives every released version a page with a body and a date, newest first', () => {
    const released = [...RELEASED].sort((a, b) => semverCompare(b, a))
    expect(pages.map((p) => p.version)).toEqual(released)
    for (const p of pages) {
      expect(p.blocks.length, p.version).toBeGreaterThan(0)
      expect(p.date, p.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('says on each page exactly what its GitHub release says', () => {
    for (const p of pages) expect(p.blocks, p.version).toEqual(notesBlocks(releaseBodyFor(p.version, mds, RELEASED)))
    expect(pages.map((p) => p.version)).not.toContain('0.9.0')
  })

  it('orders the pages by version, not by where the sections sit or how they spell', () => {
    // The real files are already newest first, so this needs sections out of order, and 0.10.0
    // against 0.9.0, where a sort by text puts 0.9.0 first.
    const shuffled = ['', '## [0.2.0] 2026-01-01\n\n- b\n\n## [0.10.0] 2026-01-03\n\n- c\n\n## [0.9.0] 2026-01-02\n\n- d']
    const order = releasePages(shuffled, new Set(['0.2.0', '0.9.0', '0.10.0'])).map((p: Page) => p.version)
    expect(order).toEqual(['0.10.0', '0.9.0', '0.2.0'])
  })

  it('has no pages when there are no tags to go by, rather than one per section', () => {
    expect(releasePages(mds, null)).toEqual([])
    expect(releasePages(mds, new Set())).toEqual([])
  })

  it('carries both parts of 0.18.0 under their labels, with the categories under each', () => {
    const p = pages.find((x) => x.version === '0.18.0')!
    expect(p.date).toBe('2026-11-08')
    expect(p.blocks.filter((b) => b.k === 'h').map((b) => b.t)).toEqual(['The app', 'The desktop shell and shared parts'])
    expect(p.blocks.find((b) => b.k === 'h3')!.t).toBe('Security')
  })

  it('leaves the coordinator changelog out', () => {
    expect((RELEASE_SOURCES as [string, string][]).map(([f]) => f)).not.toContain('helper-server/CHANGELOG.md')
  })
})
