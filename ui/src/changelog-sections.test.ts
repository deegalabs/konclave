import { fileURLToPath } from 'node:url'
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

// CI reads only the exit status of the CLI, so the status itself is tested: a lock that printed the
// violation and exited 0 would leave every check green.
describe('the lock CLI', () => {
  it('exits 1 on an edited released section and 0 on an Unreleased edit', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { execFileSync, spawnSync } = await import('node:child_process')
    const script = fileURLToPath(new URL('../../scripts/changelog-sections.mjs', import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), 'kc-lock-'))
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir })
    git('init', '-q')
    writeFileSync(join(dir, 'CHANGELOG.md'), base)
    git('add', '.'); git('commit', '-q', '-m', 'base')
    const lock = () => spawnSync('node', [script, 'lock', '--branch', 'fix/x', '--base', 'HEAD', 'CHANGELOG.md'], { cwd: dir, encoding: 'utf8' }).status
    writeFileSync(join(dir, 'CHANGELOG.md'), base.replace('- shipped thing', '- shipped thing\n- slipped in after the cut'))
    expect(lock()).toBe(1)
    writeFileSync(join(dir, 'CHANGELOG.md'), base.replace('- a\n', '- a\n- new\n'))
    expect(lock()).toBe(0)
  })
})
