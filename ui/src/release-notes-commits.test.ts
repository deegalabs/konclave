import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { commitList, commitRange, withCommits } from '../../scripts/release.mjs'

// Release notes are the CHANGELOG's prose plus the list of commits that went into the release,
// grouped by Conventional type (git-cliff, cliff.toml). The prose says what a member meets; the list
// says what changed, so nothing that shipped is left out of the notes.
describe('the commits a release lists', () => {
  const RELEASED = new Set(['0.4.0', '0.6.0', '0.10.0', '0.11.0'])

  it('run from the previous release\'s tag to this release\'s tag', () => {
    expect(commitRange('0.11.0', RELEASED)).toBe('v0.10.0..v0.11.0')
  })

  it('run to HEAD for a version not tagged yet', () => {
    expect(commitRange('0.12.0', RELEASED)).toBe('v0.11.0..HEAD')
  })

  it('start below a superseded section, so its commits are listed too', () => {
    // 0.5.0 was cut and never shipped; 0.6.0's notes carry its prose, and its commits.
    expect(commitRange('0.6.0', RELEASED)).toBe('v0.4.0..v0.6.0')
  })

  it('list nothing when no earlier release is known', () => {
    expect(commitRange('0.11.0', null)).toBeNull()
    expect(commitRange('0.11.0', new Set(['0.11.0']))).toBeNull()
  })
})

describe('the notes', () => {
  it('are the prose, then the commits under their own heading', () => {
    expect(withCommits('### Fixed\n\n- a', '### Fixed\n\n- fix: b')).toBe('### Fixed\n\n- a\n\n## Commits\n\n### Fixed\n\n- fix: b')
  })
  it('are the prose alone when there is no list', () => {
    expect(withCommits('### Fixed\n\n- a', '')).toBe('### Fixed\n\n- a')
  })
})

describe('cliff.toml', () => {
  const cfg = readFileSync(new URL('../../cliff.toml', import.meta.url), 'utf8')
  it('groups by Conventional type, security first, and collapses the housekeeping types', () => {
    for (const t of ['security', 'feat', 'fix', 'perf', 'refactor', 'docs']) expect(cfg).toMatch(new RegExp(`message = "\\^${t}`))
    expect(cfg).toMatch(/message = "\^\(build\|ci\|chore\|test\|style\|revert\)"/)
    expect(cfg.indexOf('^security')).toBeLessThan(cfg.indexOf('^feat'))
  })
  it('skips merge commits and links each line to its commit', () => {
    expect(cfg).toMatch(/message = "\^Merge ", skip = true/)
    expect(cfg).toContain('https://github.com/deegalabs/konclave/commit/{{ commit.id }}')
  })
})

// git-cliff itself, over real releases, when it is installed (the release workflow installs it).
const hasCliff = (() => { try { execFileSync('git-cliff', ['--version']); execFileSync('git', ['rev-parse', 'v0.4.0', 'v0.6.0', 'v0.11.0']); return true } catch { return false } })()
describe.skipIf(!hasCliff)('the list git-cliff writes', () => {
  const KNOWN = ['Security', 'Added', 'Fixed', 'Performance', 'Refactored', 'Documentation', 'Maintenance', 'Other']
  const run = (range: string) => execFileSync('git-cliff', ['--config', new URL('../../cliff.toml', import.meta.url).pathname, '--strip', 'all', range], { encoding: 'utf8' })
  it('only uses the known groups, in order, whatever the commit types', () => {
    for (const range of ['v0.4.0..v0.6.0', 'v0.10.0..v0.11.0']) {
      const heads = [...run(range).matchAll(/^### (.+)$/gm)].map((m) => m[1]!)
      for (const h of heads) expect(KNOWN, `${range}: ${h}`).toContain(h)
      expect(heads.map((h) => KNOWN.indexOf(h))).toEqual([...heads.map((h) => KNOWN.indexOf(h))].sort((a, b) => a - b))
    }
  })
})

describe('a git-cliff failure', () => {
  const failing = () => { const e = new Error('Command failed: git-cliff') as Error & { stderr: string }; e.stderr = 'Error: Git error: `revspec not found`'; throw e }
  it('fails the release notes in CI, saying why', () => {
    expect(() => commitList('0.11.0', { run: failing, ci: true, tagged: new Set(['0.10.0', '0.11.0']) })).toThrow(/revspec not found/)
  })
  it('outside CI leaves the prose and says why', () => {
    const said: string[] = []
    expect(commitList('0.11.0', { run: failing, ci: false, tagged: new Set(['0.10.0', '0.11.0']), warn: (m: string) => said.push(m) })).toBe('')
    expect(said.join('\n')).toMatch(/revspec not found/)
  })
})
