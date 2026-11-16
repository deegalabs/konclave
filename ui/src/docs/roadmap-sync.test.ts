import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  asOfFrom,
  diffInfo,
  issueInfo,
  pullInfo,
  refKeysOf,
  render,
  sync,
  // @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
} from '../../../scripts/roadmap-sync.mjs'
import { REFS_AS_OF } from './roadmap-refs'

// The roadmap's titles and states are read from GitHub by a script and committed, so reading the docs
// calls nobody. These tests hold the script's rules without a network: every GitHub answer is a fixture.

const REPO = 'deegalabs/konclave'
const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`
const pullUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`
const issue = (n: number, more: object = {}) => ({ number: n, title: `Issue ${n}`, html_url: issueUrl(n), state: 'open', state_reason: null, ...more })
const pull = (n: number, more: object = {}) => ({ number: n, title: `Pull ${n}`, html_url: pullUrl(n), state: 'open', draft: false, merged_at: null, ...more })

describe('roadmap-sync: what GitHub says becomes a state', () => {
  it('maps an issue to open, closed or not planned', () => {
    expect(issueInfo(issue(1), 1)).toEqual({ title: 'Issue 1', state: 'open' })
    expect(issueInfo(issue(1, { state: 'open', state_reason: 'reopened' }), 1).state).toBe('open')
    expect(issueInfo(issue(1, { state: 'closed', state_reason: 'completed' }), 1).state).toBe('closed')
    expect(issueInfo(issue(1, { state: 'closed', state_reason: null }), 1).state).toBe('closed')
    expect(issueInfo(issue(1, { state: 'closed', state_reason: 'not_planned' }), 1).state).toBe('not-planned')
  })

  it('refuses what it cannot name honestly, instead of guessing', () => {
    // A duplicate is not "not planned": the work may be tracked elsewhere. A person decides what the page says.
    expect(() => issueInfo(issue(1, { state: 'closed', state_reason: 'duplicate' }), 1)).toThrow(/duplicate/)
    expect(() => issueInfo(issue(1, { state: 'locked' }), 1)).toThrow(/state/)
    // issue(N) on the page while GitHub says N is a pull request: the page is wrong, the script does not fix it.
    expect(() => issueInfo(issue(1, { pull_request: { url: 'x' } }), 1)).toThrow(/pull request/)
    expect(() => issueInfo(issue(2), 1)).toThrow(/number/)
    expect(() => issueInfo(issue(1, { html_url: 'https://github.com/someone/else/issues/1' }), 1)).toThrow(/url/)
    expect(() => issueInfo(issue(1, { title: '' }), 1)).toThrow(/title/)
  })

  it('maps a pull request to draft, open, merged or closed unmerged', () => {
    expect(pullInfo(pull(7, { draft: true }), 7)).toEqual({ title: 'Pull 7', state: 'draft' })
    expect(pullInfo(pull(7), 7).state).toBe('open')
    expect(pullInfo(pull(7, { state: 'closed', merged_at: '2026-10-20T11:28:55Z' }), 7).state).toBe('merged')
    expect(pullInfo(pull(7, { state: 'closed' }), 7).state).toBe('closed-unmerged')
    expect(() => pullInfo(pull(7, { html_url: issueUrl(7) }), 7)).toThrow(/url/)
  })

  it('dates the snapshot by the day GitHub answered, in both languages', () => {
    expect(asOfFrom('Sun, 15 Nov 2026 23:59:59 GMT')).toEqual({ iso: '2026-11-15', 'pt-BR': '15 de novembro de 2026', en: '15 November 2026' })
    expect(asOfFrom('Fri, 01 Mar 2030 00:00:00 GMT')).toEqual({ iso: '2030-03-01', 'pt-BR': '1 de março de 2030', en: '1 March 2030' })
    expect(() => asOfFrom(null)).toThrow(/date/i)
    expect(() => asOfFrom('not a date')).toThrow(/date/i)
  })
})

describe('roadmap-sync: the list and the file', () => {
  it('takes the refs in page order, once each, from every list of stages', () => {
    const a = { refs: [{ kind: 'issue', n: 3 }, { kind: 'pull', n: 9 }] }
    const b = { refs: [{ kind: 'issue', n: 3 }, { kind: 'issue', n: 1 }] }
    expect(refKeysOf([[a], [b]])).toEqual([
      { kind: 'issue', n: 3, key: 'issue:3' },
      { kind: 'pull', n: 9, key: 'pull:9' },
      { kind: 'issue', n: 1, key: 'issue:1' },
    ])
  })

  it('writes any title as data, never as code', () => {
    const hostile = "it's `${process.exit()}` */ \"quoted\"\nline ↔ two"
    const asOf = asOfFrom('Sun, 15 Nov 2026 12:00:00 GMT')
    const out: string = render(asOf, new Map([['issue:1', { title: hostile, state: 'open' }]]))
    const body = out.slice(out.indexOf('REF_INFO'))
    const json = body.slice(body.indexOf('= ') + 2).trim()
    expect(JSON.parse(json)).toEqual({ 'issue:1': { title: hostile, state: 'open' } })
    expect(out).toContain(`export const REFS_AS_OF = ${JSON.stringify(asOf)}`)
  })

  it('names every difference between the committed file and GitHub', () => {
    const before = { 'issue:1': { title: 'A', state: 'open' }, 'issue:2': { title: 'B', state: 'open' }, 'issue:4': { title: 'D', state: 'open' } }
    const after = new Map([
      ['issue:1', { title: 'A', state: 'closed' }],
      ['issue:2', { title: 'B2', state: 'open' }],
      ['issue:3', { title: 'C', state: 'open' }],
    ])
    expect(diffInfo(before, after)).toEqual([
      'issue:1 state: open -> closed',
      'issue:2 title: "B" -> "B2"',
      'issue:3 is new',
      'issue:4 is no longer on the page',
    ])
    expect(diffInfo({ 'issue:1': { title: 'A', state: 'open' } }, new Map([['issue:1', { title: 'A', state: 'open' }]]))).toEqual([])
  })

  it('treats a failed read as a failure, never as "nothing changed"', async () => {
    const stages = [[{ refs: [{ kind: 'issue', n: 1 }] }]]
    const down = async () => new Response('busy', { status: 503 })
    await expect(sync({ stages, fetchImpl: down })).rejects.toThrow(/503/)
    const offline = async () => { throw new TypeError('fetch failed') }
    await expect(sync({ stages, fetchImpl: offline })).rejects.toThrow(/fetch failed/)
  })

  it('reads issues and pull requests from their own endpoints', async () => {
    const stages = [[{ refs: [{ kind: 'issue', n: 1 }, { kind: 'pull', n: 2 }] }]]
    const asked: string[] = []
    const fake = async (url: string) => {
      asked.push(url)
      const body = url.endsWith('/issues/1') ? issue(1) : pull(2, { state: 'closed', merged_at: '2026-11-01T00:00:00Z' })
      return new Response(JSON.stringify(body), { status: 200, headers: { date: 'Sun, 15 Nov 2026 12:00:00 GMT' } })
    }
    const { asOf, info } = await sync({ stages, fetchImpl: fake })
    expect(asked).toEqual([`https://api.github.com/repos/${REPO}/issues/1`, `https://api.github.com/repos/${REPO}/pulls/2`])
    expect(asOf.iso).toBe('2026-11-15')
    expect([...info.entries()]).toEqual([
      ['issue:1', { title: 'Issue 1', state: 'open' }],
      ['pull:2', { title: 'Pull 2', state: 'merged' }],
    ])
  })

  // Both tests below start a separate Node, which a loaded machine can make slow: hence the longer timeout.
  // Vitest resolves imports Node does not (a path with no extension), so the script could pass here and
  // fail when run. This loads it the way the CI and a person run it.
  it('loads under plain Node, with the roadmap it reads', () => {
    const root = join(__dirname, '..', '..', '..')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const m = await import('./scripts/roadmap-sync.mjs'); console.log(typeof m.sync)"], { cwd: root, encoding: 'utf8' })
    expect(out.trim()).toBe('function')
  }, 30_000)

  // CI runs in UTC, where a local-time date and a UTC one agree. Run the rule in zones where they do not.
  it('dates by UTC whatever the machine zone', () => {
    const root = join(__dirname, '..', '..', '..')
    for (const TZ of ['Pacific/Kiritimati', 'America/Sao_Paulo']) {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        "const m = await import('./scripts/roadmap-sync.mjs'); console.log(JSON.stringify([m.asOfFrom('Sun, 15 Nov 2026 23:30:00 GMT'), m.asOfFrom('Mon, 16 Nov 2026 00:30:00 GMT')]))"],
      { cwd: root, encoding: 'utf8', env: { ...process.env, TZ } })
      // The whole date, words included: the iso part alone comes out in UTC whatever the zone.
      expect(JSON.parse(out), TZ).toEqual([
        { iso: '2026-11-15', 'pt-BR': '15 de novembro de 2026', en: '15 November 2026' },
        { iso: '2026-11-16', 'pt-BR': '16 de novembro de 2026', en: '16 November 2026' },
      ])
    }
  }, 30_000)

  it('commits a date whose words match its day', () => {
    expect(REFS_AS_OF).toEqual(asOfFrom(new Date(`${REFS_AS_OF.iso}T12:00:00Z`).toUTCString()))
  })

  it('sends the token when it has one, and none otherwise', async () => {
    const seen: (string | undefined)[] = []
    const fake = async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.authorization)
      return new Response(JSON.stringify(issue(1)), { status: 200, headers: { date: 'Sun, 15 Nov 2026 12:00:00 GMT' } })
    }
    const stages = [[{ refs: [{ kind: 'issue', n: 1 }] }]]
    await sync({ stages, fetchImpl: fake, token: 't0k' })
    await sync({ stages, fetchImpl: fake })
    expect(seen).toEqual(['Bearer t0k', undefined])
  })
})
