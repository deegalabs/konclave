import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { parseSections, sectionBody, lockViolations, versionsIn, CATEGORIES } from '../../scripts/changelog-sections.mjs'

// The single reader of a changelog's structure. Four scripts used to carry their own parser; the
// released-sections lock would have been a fifth. Fixtures only: nothing here reads the real files.
const base = `# Changelog

## [Unreleased]

### Fixed

- a

---

## [0.16.0] 2026-10-20

### Added

- shipped thing

## [0.15.0] 2026-10-10

### Fixed

- older
`

describe('parsing', () => {
  it('lists version sections and Unreleased, ignoring prose headings', () => {
    const md = base + '\n## The categories decide\n\n### Fixed\n### Fixed\n'
    expect(parseSections(md).map((s: { title: string }) => s.title)).toEqual(['Unreleased', '0.16.0', '0.15.0'])
    expect(versionsIn(md)).toEqual(['0.16.0', '0.15.0'])
  })
  it('reads one body without the trailing rule', () => {
    expect(sectionBody(base, 'Unreleased')).toBe('### Fixed\n\n- a')
  })
  it('knows the five categories', () => {
    expect(CATEGORIES).toEqual(['security', 'added', 'changed', 'fixed', 'known-limits'])
  })
})

describe('the released-sections lock', () => {
  const lock = (head: string, branch = 'fix/x') => lockViolations(base, head, { headBranch: branch })

  it('passes when only Unreleased changes', () => {
    expect(lock(base.replace('- a', '- a\n- b'))).toEqual([])
  })
  it('fails when an entry lands in a numbered section', () => {
    expect(lock(base.replace('- shipped thing', '- shipped thing\n- sneaked in'))).toEqual(['0.16.0'])
  })
  it('ignores blank-line differences', () => {
    expect(lock(base.replace('### Added\n\n- shipped thing', '### Added\n\n\n- shipped thing  '))).toEqual([])
  })
  it('fails when a numbered section disappears', () => {
    expect(lock(base.replace(/## \[0\.15\.0\][\s\S]*/, ''))).toEqual(['0.15.0'])
  })
  it('lets a new numbered section in only from a release branch', () => {
    const cut = base.replace('## [0.16.0]', '## [0.17.0] 2026-10-31\n\n### Fixed\n\n- a\n\n## [0.16.0]')
    expect(lock(cut)).toEqual(['0.17.0'])
    expect(lock(cut, 'pre-release/v0.17.0')).toEqual([])
    expect(lock(cut, 'release/v0.17.0')).toEqual([])
    expect(lock(cut, 'hotfix/signing')).toEqual([])
  })
})
