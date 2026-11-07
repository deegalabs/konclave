import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error - plain .mjs scripts
import { mergeFragments, readFragments, fragmentProblem, compileFragments } from '../../scripts/changelog-sections.mjs'
// @ts-expect-error - plain .mjs scripts
import { missingChangelogs } from '../../scripts/changelog-gate.mjs'

const md = `# Changelog

## [Unreleased]

### Fixed

- old fix

## [0.1.0] 2026-01-01

### Added

- first
`

describe('merging fragments into Unreleased', () => {
  it('appends to an existing category and creates a missing one in canonical order', () => {
    const out = mergeFragments(md, [
      { category: 'fixed', name: 'a', body: '- new fix' },
      { category: 'security', name: 'b', body: '- closes a hole' },
    ])
    const un = out.slice(0, out.indexOf('## [0.1.0]'))
    expect(un.indexOf('### Security')).toBeGreaterThan(-1)
    expect(un.indexOf('### Security')).toBeLessThan(un.indexOf('### Fixed'))
    expect(un).toContain('- old fix\n- new fix')
    expect((out.match(/### Fixed/g) ?? []).length).toBe(1)
    expect(out).toContain('## [0.1.0] 2026-01-01\n\n### Added\n\n- first')
  })
  it('puts a category that exists only in fragments in its canonical place', () => {
    const out = mergeFragments(md, [{ category: 'known-limits', name: 'k', body: '- limit' }])
    expect(out.indexOf('### Fixed')).toBeLessThan(out.indexOf('### Known limits'))
  })
  it('orders by file name, deterministically', () => {
    const a = mergeFragments(md, [{ category: 'fixed', name: 'b', body: '- B' }, { category: 'fixed', name: 'a', body: '- A' }])
    expect(a).toContain('- old fix\n- A\n- B')
  })
  it('with no fragments changes nothing', () => expect(mergeFragments(md, [])).toBe(md))
})

describe('what a fragment must be', () => {
  it('accepts a bullet in a known category', () => {
    expect(fragmentProblem('changelog.d/fixed/x.md', '- text')).toBeNull()
    expect(fragmentProblem('ui/changelog.d/known-limits/x.md', '- text\n  more')).toBeNull()
  })
  it.each([
    ['changelog.d/oops/x.md', '- t'], ['changelog.d/fixed/x.md', ''], ['changelog.d/fixed/x.md', 'no bullet'],
  ])('refuses %s', (p, b) => expect(typeof fragmentProblem(p, b)).toBe('string'))
})

describe('the gate', () => {
  it('a fragment added beside the file satisfies it', () => {
    expect(missingChangelogs(['ui/src/api.ts', 'ui/changelog.d/fixed/x.md'])).toEqual([])
    expect(missingChangelogs(['ui/src/api.ts', 'changelog.d/fixed/x.md'])).toEqual(['ui/CHANGELOG.md'])
  })
  it('a deleted fragment does not', () => {
    expect(missingChangelogs(['ui/src/api.ts', 'D\tui/changelog.d/fixed/x.md'])).toEqual(['ui/CHANGELOG.md'])
    expect(missingChangelogs(['M\tui/src/api.ts', 'A\tui/changelog.d/fixed/x.md'])).toEqual([])
  })
  it('an invalid category directory does not', () => {
    expect(missingChangelogs(['ui/src/api.ts', 'ui/changelog.d/oops/x.md'])).toEqual(['ui/CHANGELOG.md'])
  })
})

describe('with real git', () => {
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' })
  it('two branches adding fragments to the same category merge without conflict', () => {
    const d = mkdtempSync(join(tmpdir(), 'frag-'))
    git(d, 'init', '-q', '-b', 'main')
    writeFileSync(join(d, 'CHANGELOG.md'), md)
    git(d, 'add', '.'); git(d, 'commit', '-qm', 'base')
    for (const b of ['one', 'two']) {
      git(d, 'checkout', '-q', '-b', b, 'main')
      mkdirSync(join(d, 'changelog.d/fixed'), { recursive: true })
      writeFileSync(join(d, `changelog.d/fixed/${b}.md`), `- ${b}\n`)
      git(d, 'add', '.'); git(d, 'commit', '-qm', b)
    }
    git(d, 'checkout', '-q', 'one')
    git(d, 'merge', '-q', '--no-edit', 'two')
    expect(readFragments(join(d, 'changelog.d')).map((f: { name: string }) => f.name)).toEqual(['one', 'two'])
  })
  it('the cut compiles into the file, deletes the fragments, and a repeat changes nothing', () => {
    const d = mkdtempSync(join(tmpdir(), 'cut-'))
    mkdirSync(join(d, 'changelog.d/fixed'), { recursive: true })
    writeFileSync(join(d, 'changelog.d/fixed/x.md'), '- from fragment\n')
    writeFileSync(join(d, 'CHANGELOG.md'), md)
    const once = compileFragments(join(d, 'CHANGELOG.md'), join(d, 'changelog.d'))
    expect(once).toBe(1)
    expect(readFileSync(join(d, 'CHANGELOG.md'), 'utf8')).toContain('- old fix\n- from fragment')
    expect(existsSync(join(d, 'changelog.d/fixed/x.md'))).toBe(false)
    const text = readFileSync(join(d, 'CHANGELOG.md'), 'utf8')
    expect(compileFragments(join(d, 'CHANGELOG.md'), join(d, 'changelog.d'))).toBe(0)
    expect(readFileSync(join(d, 'CHANGELOG.md'), 'utf8')).toBe(text)
    expect(readdirSync(join(d, 'changelog.d/fixed'))).toEqual([])
  })
})
