import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { releaseBodyFor, releasedVersions, releasePagesOrFail, readReleaseSources, SUPERSEDED, versionsIn } from '../../scripts/changelog-sections.mjs'
import { codeOf } from './source-scan'

// The release pages take their versions from the changelog headings, not from git tags: CI's UI job
// and Vercel clone with no tags, and a build that depends on them ships nothing there. A section cut
// and superseded before it was published is the one thing the tags said that the headings do not,
// so those are listed by hand (SUPERSEDED). Zero pages stops the build.
const MD = '# Changelog\n\n## [Unreleased]\n\n## [0.18.0] - 2026-11-08\n\n### Security\n\n- A fix.\n\n## [0.9.0] - 2026-10-03\n\n### Added\n\n- Cut, never published.\n'

describe('releasedVersions', () => {
  it('is every numbered heading but the superseded ones, with no git at all', () => {
    expect([...releasedVersions([MD])]).toEqual(['0.18.0'])
  })

  it('reads the real changelogs: the superseded cuts have no page, the releases that shipped them do', () => {
    const mds = readReleaseSources()
    const released = releasedVersions(mds)
    for (const v of ['0.5.0', '0.9.0']) expect(released.has(v), v).toBe(false)
    for (const v of ['0.6.0', '0.10.0', '0.19.0']) expect(released.has(v), v).toBe(true)
    // a superseded version that is not a heading is a typo, and would hide nothing
    const headings = new Set(mds.flatMap(versionsIn))
    for (const v of SUPERSEDED) expect(headings.has(v), v).toBe(true)
  })

  it('folds a superseded cut into the page of the release that shipped it, as the GitHub body does', () => {
    const mds = readReleaseSources()
    const page = releasePagesOrFail(mds).find((p: { version: string }) => p.version === '0.6.0')
    expect(page).toBeTruthy()
    const body = releaseBodyFor('0.6.0', mds, releasedVersions(mds))
    // 0.5.0's section rides on 0.6.0: its body carries what only the 0.5.0 heading holds
    expect(body.length).toBeGreaterThan(releaseBodyFor('0.6.0', mds, new Set(['0.6.0', '0.5.0'])).length)
  })
})

describe('releasePagesOrFail', () => {
  it('stops the build when there are no pages', () => {
    expect(() => releasePagesOrFail(['# Changelog\n\n## [Unreleased]\n'])).toThrow(/no released version/)
    expect(() => releasePagesOrFail(['# Changelog\n\n## [0.9.0] - 2026-10-03\n\n- x\n'])).toThrow(/no released version/)
  })
  it('returns the pages when there are some', () => {
    expect(releasePagesOrFail([MD]).map((p: { version: string }) => p.version)).toEqual(['0.18.0'])
  })
  it('is what the build calls, with no tag in the way', () => {
    const cfg = codeOf('../vite.config.ts')
    expect(cfg).toMatch(/releasePagesOrFail\(mds\)/)
    expect(cfg).not.toMatch(/tagsForPages|taggedVersions/)
  })
})
