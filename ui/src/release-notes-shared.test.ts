import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { RELEASE_SOURCES, notesBlocks, releaseBody, releasePages, versionsIn } from '../../scripts/changelog-sections.mjs'

type Block = { k: string; t?: string; items?: string[] }
type Page = { version: string; date: string; blocks: Block[] }

// The docs' release pages are built from the same function that writes the GitHub release body, so a
// release is never written twice. These pin the conversion, and that every release has a page.
const read = (file: string) => readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8')
const mds = (RELEASE_SOURCES as [string, string][]).map(([file]) => read(file))

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
})

describe('the release pages, from the real changelogs', () => {
  const pages: Page[] = releasePages(mds)

  it('gives every released version a page with a body and a date', () => {
    const released = [...new Set(mds.flatMap((md) => versionsIn(md) as string[]))]
    expect(pages.map((p) => p.version).sort()).toEqual(released.sort())
    for (const p of pages) {
      expect(p.blocks.length, p.version).toBeGreaterThan(0)
      expect(p.date, p.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('lists the newest first', () => {
    const [a, b] = pages
    expect(a!.version.localeCompare(b!.version, 'en', { numeric: true })).toBeGreaterThan(0)
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
