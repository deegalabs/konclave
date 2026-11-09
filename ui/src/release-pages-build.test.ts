import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { releasePagesOrFail, tagsForPages } from '../../scripts/changelog-sections.mjs'
import { codeOf } from './source-scan'

// CI's UI job and Vercel clone shallow, with no tags: the build fetches them, and stops on zero pages.
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
const repos: string[] = []
const repo = (tagged: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), 'kc-tags-')); repos.push(dir)
  git(dir, 'init', '-q'); writeFileSync(join(dir, 'f'), 'x'); git(dir, 'add', 'f')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c')
  if (tagged) git(dir, 'tag', 'v0.18.0')
  return dir
}
afterEach(() => { while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true }) })

const MD = '# Changelog\n\n## [0.18.0] - 2026-11-08\n\n### Security\n\n- A fix.\n'

describe('tagsForPages', () => {
  it('uses the tags the clone has and fetches nothing', () => {
    const calls: string[][] = []
    const tags = tagsForPages(repo(true), (_: string, args: string[]) => { calls.push(args) })
    expect([...tags]).toEqual(['0.18.0'])
    expect(calls).toEqual([])
  })

  it('fetches the tags, and only the tags, when the clone has none', () => {
    const dir = repo(false)
    const calls: string[][] = []
    const tags = tagsForPages(dir, (_: string, args: string[]) => { calls.push(args); git(dir, 'tag', 'v0.17.0') })
    expect(calls).toEqual([['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', '+refs/tags/*:refs/tags/*']])
    expect([...tags]).toEqual(['0.17.0'])
  })

  it('returns no tags when the fetch fails, for the caller to refuse', () => {
    const tags = tagsForPages(repo(false), () => { throw new Error('offline') })
    expect(tags?.size ?? 0).toBe(0)
  })
})

describe('releasePagesOrFail', () => {
  it('stops the build when there are no pages', () => {
    expect(() => releasePagesOrFail([MD], new Set())).toThrow(/no tagged version/)
    expect(() => releasePagesOrFail([MD], null)).toThrow(/no tagged version/)
  })

  it('returns the pages when there are some', () => {
    expect(releasePagesOrFail([MD], new Set(['0.18.0'])).map((p: { version: string }) => p.version)).toEqual(['0.18.0'])
  })

  it('is what the build calls, with the fetched tags', () => {
    expect(codeOf('../vite.config.ts')).toMatch(/releasePagesOrFail\(mds, tagsForPages\(\)\)/)
  })
})
