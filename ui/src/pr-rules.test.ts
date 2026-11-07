import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { branchProblem, sizeReport, remoteBranchesToCheck } from '../../scripts/pr-rules.mjs'

// The branch-name rule and the size warning live in scripts/pr-rules.mjs; the CI job and the
// pre-push hook only call it. These cases are real branch names from the repo's history.
describe('branch names', () => {
  it.each([
    'fix/302-ledger-exports', 'fix/amount-comma-decimal', 'feat/proposal-desk', 'pre-release/v0.16.1',
    'release/v1.2.3', 'ci/branch-name-and-pr-size', 'hotfix/signing-replay',
  ])('accepts %s', (b) => expect(branchProblem(b)).toBeNull())

  it.each([
    'chore/lock-coordinator-404a8bb', // a hash word
    'kc/servers-270',                 // unknown type
    'release/v0.13.2-cut',            // not an exact version
    'docs/changelog-describes-the-whole-release', // over 40 characters
    'fix/w3b-something',              // a wave code
    'local/ci-gates',                 // local-only, never pushed
    'fix/UpperCase',
    'kc-produto-1',
    'fix/kc-produto-thing',           // a session name as the slug
    'pre-release/0.1.0',
  ])('refuses %s', (b) => expect(typeof branchProblem(b)).toBe('string'))

  it('exempts staging and main only from this repository', () => {
    expect(branchProblem('staging', { sameRepo: true })).toBeNull()
    expect(branchProblem('main', { sameRepo: true })).toBeNull()
    expect(branchProblem('main', { sameRepo: false })).not.toBeNull()
  })
})

describe('size', () => {
  const n = (path: string, a: number, d = 0) => ({ path, added: a, deleted: d })
  it('counts code, not tests, generated files or the records', () => {
    const r = sizeReport([
      n('ui/src/a.ts', 200), n('ui/src/a.test.ts', 900), n('ui/src/wasm-pkg/x.js', 5000),
      n('pnpm-lock.yaml', 4000), n('CHANGELOG.md', 80), n('changelog.d/fixed/x.md', 3),
    ])
    expect(r.lines).toBe(200)
    expect(r.warn).toBe(false)
    expect(r.touchedTests).toBe(true)
  })
  it('warns above 300', () => {
    expect(sizeReport([n('src-tauri/src/a.rs', 250, 60)]).warn).toBe(true)
  })
})

describe('pre-push hook input', () => {
  const line = (l: string, r: string, rsha = 'a'.repeat(40)) => `refs/heads/${l} ${'b'.repeat(40)} refs/heads/${r} ${rsha}`
  it('checks the REMOTE name, skipping deletions and tags', () => {
    const zero = '0'.repeat(40)
    const out = remoteBranchesToCheck([
      line('local/x', 'fix/y'),
      line('fix/y', 'local/x'),
      `(delete) ${zero} refs/heads/gone ${'a'.repeat(40)}`,
      `refs/tags/v1 ${'b'.repeat(40)} refs/tags/v1 ${zero}`,
    ].join('\n'))
    expect(out).toEqual(['fix/y', 'local/x'])
  })
  it('the hook refuses a bad remote name and lets a good one through', () => {
    const run = (stdin: string) => spawnSync('sh', ['.githooks/pre-push', 'origin', 'x'], {
      cwd: new URL('../../', import.meta.url).pathname, input: stdin, encoding: 'utf8',
      env: { ...process.env, KONCLAVE_PRE_PUSH_SKIP_DIFF: '1' },
    })
    expect(run(line('fix/y', 'local/x') + '\n').status).not.toBe(0)
    expect(run(line('local/x', 'fix/y') + '\n').status).toBe(0)
  })
})

describe('the CLI runs from a path with a space (the hook must never approve everything in silence)', () => {
  it('refuses a bad branch name even when the script sits in a directory with a space in its name', async () => {
    const { execFileSync } = await import('node:child_process')
    const { mkdtempSync, mkdirSync, copyFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = join(mkdtempSync(join(tmpdir(), 'pr rules ')), 'scripts dir')
    mkdirSync(dir)
    const script = join(dir, 'pr-rules.mjs')
    copyFileSync(join(__dirname, '..', '..', 'scripts', 'pr-rules.mjs'), script)
    let code = 0
    try {
      execFileSync('node', [script, 'check', '--branch', 'Bad'], { stdio: 'pipe' })
    } catch (e) {
      code = (e as { status?: number }).status ?? -1
    }
    expect(code).toBe(1)
  })
})
