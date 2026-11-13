import { describe, expect, it } from 'vitest'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { commitMismatch, compareRunning, exitCodeOf, lockDeployCommit, minCreationIn, uiCustomHeaders } from '../../scripts/what-is-running.mjs'

// The daily "what is running" check compares production with the deploy the repository
// records, not with a feature list. These tests pin the comparison: each production fact, made to
// differ, turns the run red; staging only ever warns.

const MAIN_TIP = '98fa8ae934432802af88b602a7715cbb704fc5c7'
const expected = {
  coordinator: { commit: '027c4a6c0bf371d6f05321902eaf8b8ce8e488ef', creation: 4 },
  relayDigest: '68c687b62bc3d547',
  web: { version: '0.20.0', commit: MAIN_TIP },
}
const APP = ['Content-Type', 'X-Konclave-Read', 'X-Konclave-Session']
const RELAY = ['Content-Type', 'X-Konclave-Session']

type Row = { level: string; name: string; detail: string }

const observed = () => ({
  coordinators: [
    { name: 'helper.konclave.xyz', health: { helper_commit: '027c4a6c', client: { creation: 4 } } as Record<string, unknown> | null },
    { name: 'konclave-helper-production.up.railway.app', health: { helper_commit: '027c4a6c', client: { creation: 4 } } as Record<string, unknown> | null },
  ],
  relays: [{ name: 'relay.konclave.xyz', health: { source_digest: '68c687b62bc3d547' } as Record<string, unknown> | null }],
  // The web runs the tip of main, which can be newer than the release tag (a docs hotfix, #920).
  webs: [{ name: 'www.konclave.xyz', version: { version: '0.20.0', commit: '98fa8ae' } as Record<string, unknown> | null }],
  preflights: [
    { name: 'helper.konclave.xyz', headers: APP, allow: 'Content-Type, X-Konclave-Read, X-Konclave-Session' as string | null },
    { name: 'relay.konclave.xyz', headers: RELAY, allow: 'Content-Type, X-Konclave-Session' as string | null },
  ],
  staging: { commit: '027c4a6c' as string | null, serviceCodeEqual: true },
})

const run = (o: ReturnType<typeof observed>): Row[] => compareRunning(expected, o)

describe('compareRunning', () => {
  it('is green when production is the recorded deploy', () => {
    expect(exitCodeOf(run(observed()))).toBe(0)
  })

  it('is red when a coordinator runs another commit', () => {
    const o = observed()
    o.coordinators[1]!.health = { helper_commit: '39b5059a', client: { creation: 4 } }
    expect(exitCodeOf(run(o))).toBe(1)
  })

  it('is red when a coordinator expects another creation protocol, or none', () => {
    const o = observed()
    o.coordinators[0]!.health = { helper_commit: '027c4a6c', client: { creation: 3 } }
    expect(exitCodeOf(run(o))).toBe(1)
    const p = observed()
    p.coordinators[0]!.health = { helper_commit: '027c4a6c' }
    expect(exitCodeOf(run(p))).toBe(1)
  })

  it('is red when the relay is built from other sources, and says why', () => {
    const o = observed()
    o.relays[0]!.health = { source_digest: 'ba546740f3d136f5' }
    const rows = run(o)
    expect(exitCodeOf(rows)).toBe(1)
    expect(rows.find((r) => r.level === 'red')?.detail).toContain('not redeployed')
  })

  it('is red when the web runs another commit or another version', () => {
    const o = observed()
    o.webs[0]!.version = { version: '0.20.0', commit: '027c4a6' }
    expect(exitCodeOf(run(o))).toBe(1)
    const p = observed()
    p.webs[0]!.version = { version: '0.19.0', commit: '98fa8ae' }
    expect(exitCodeOf(run(p))).toBe(1)
  })

  it('is red when a preflight drops a header the app sends (#466), naming it', () => {
    const o = observed()
    o.preflights[0]!.allow = 'Content-Type, X-Konclave-Session'
    const rows = run(o)
    expect(exitCodeOf(rows)).toBe(1)
    expect(rows.find((r) => r.level === 'red')?.detail).toContain('X-Konclave-Read')
    const p = observed()
    p.preflights[1]!.allow = 'Content-Type'
    expect(exitCodeOf(run(p))).toBe(1)
  })

  it('is red when the scan of the app found no custom header, instead of checking nothing', () => {
    const o = observed()
    o.preflights[1]!.headers = ['Content-Type']
    const rows = run(o)
    expect(exitCodeOf(rows)).toBe(1)
    expect(rows.find((r) => r.level === 'red')?.detail).toContain('found no X-Konclave')
  })

  it('reads an allow-list without regard to case or spacing', () => {
    const o = observed()
    o.preflights[0]!.allow = 'content-type,x-konclave-read ,X-KONCLAVE-SESSION'
    expect(exitCodeOf(run(o))).toBe(0)
  })

  it.each(['coordinators', 'relays', 'webs', 'preflights'] as const)('is red when a %s host does not answer', (kind) => {
    const o = observed()
    if (kind === 'webs') o.webs[0]!.version = null
    else if (kind === 'preflights') o.preflights[1]!.allow = null
    else o[kind][0]!.health = null
    expect(exitCodeOf(run(o))).toBe(1)
  })

  it('only warns about staging, whatever it runs or if it is down', () => {
    const o = observed()
    o.staging = { commit: '4484aa37', serviceCodeEqual: false }
    const rows = run(o)
    expect(rows.some((r) => r.level === 'warn')).toBe(true)
    expect(exitCodeOf(rows)).toBe(0)
    const p = observed()
    p.staging = { commit: null, serviceCodeEqual: false }
    expect(exitCodeOf(run(p))).toBe(0)
  })
})

describe('commitMismatch', () => {
  it('matches a short hash of any length against the full one', () => {
    expect(commitMismatch('027c4a6', expected.coordinator.commit)).toBeNull()
    expect(commitMismatch('027c4a6c', expected.coordinator.commit)).toBeNull()
    expect(commitMismatch('027c4a6c0', expected.coordinator.commit)).toBeNull()
  })

  it('refuses another commit, a dirty build, a non-hash and nothing', () => {
    expect(commitMismatch('39b5059a', expected.coordinator.commit)).not.toBeNull()
    expect(commitMismatch('027c4a6d', expected.coordinator.commit)).not.toBeNull()
    expect(commitMismatch('027c4a6c-dirty', expected.coordinator.commit)).toContain('uncommitted')
    expect(commitMismatch('unknown', expected.coordinator.commit)).not.toBeNull()
    expect(commitMismatch(undefined, expected.coordinator.commit)).toBe('absent')
  })
})

describe('what the repository records', () => {
  it('takes the commit of the [deploy_build] table, not a commented record or another table', () => {
    const lock = [
      '# [deploy_build]',
      '# commit      = "aaaaaaaa"',
      '[engine]',
      'commit      = "bbbbbbbb"',
      '[deploy_build]',
      'date        = "2026-11-11"',
      '# commit      = "cccccccc"',
      'commit      = "027c4a6c"',
      '',
      '[[deploy_binary]]',
    ].join('\n')
    expect(lockDeployCommit(lock)).toBe('027c4a6c')
    expect(() => lockDeployCommit('[engine]\ncommit = "x"')).toThrow()
  })

  it('reads the shipped creation minimum from the coordinator source', () => {
    expect(minCreationIn('/// doc\nconst MIN_CREATION: u32 = 4;\n')).toBe(4)
    expect(() => minCreationIn('const OTHER: u32 = 4;')).toThrow()
  })

  it('collects the custom headers the app sends, once each, with Content-Type', () => {
    const src = `headers: { 'Content-Type': 'application/json', 'X-Konclave-Session': SESSION }\n` +
      `h['X-Konclave-Read'] = key\nother('X-Konclave-Read')`
    expect(uiCustomHeaders(src)).toEqual(APP)
  })
})
