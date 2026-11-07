// Branch-name and PR-size rules. One home: the CI job `PR rules` and the pre-push hook only CALL
// this file, so the two cannot drift. The size rule only warns; the name rule blocks.
//
// What a machine cannot judge stays in review: whether a name of an embargoed branch is neutral,
// and whether the slug says the problem.
import { execSync } from 'node:child_process'

export const TYPES = ['feat', 'fix', 'docs', 'chore', 'security', 'test', 'refactor', 'perf', 'build', 'ci', 'revert', 'hotfix']
export const MAX_BRANCH = 40
export const SIZE_LIMIT = 300

/** null when the branch name is fine, otherwise the reason (public text: keep it neutral). */
export function branchProblem(name, { sameRepo = true } = {}) {
  if ((name === 'staging' || name === 'main') && sameRepo) return null
  if (name.startsWith('local/')) return 'local/* branches are local-only and are never pushed.'
  if (/^(pre-release|release)\//.test(name)) {
    return /^(pre-release|release)\/v\d+\.\d+\.\d+$/.test(name)
      ? null : 'release branches are release/vX.Y.Z or pre-release/vX.Y.Z, with an exact version.'
  }
  if (name.length > MAX_BRANCH) return `the name is ${name.length} characters; the limit is ${MAX_BRANCH}.`
  const m = /^([a-z]+)\/([a-z0-9][a-z0-9-]*)$/.exec(name)
  if (!m) return 'use <type>/<slug>: lowercase letters, digits and hyphens.'
  if (!TYPES.includes(m[1])) return `unknown type "${m[1]}"; use one of ${TYPES.join(', ')}.`
  const slug = m[2]
  if (slug.startsWith('kc')) return 'the slug must not start with "kc".'
  for (const w of slug.split('-')) {
    if (/^[0-9a-f]{7,40}$/.test(w) && /\d/.test(w)) return `"${w}" looks like a commit hash; say the problem instead.`
    if (/^w\d+[a-z]?$/.test(w)) return `"${w}" looks like a wave code; say the problem instead.`
  }
  return null
}

const GENERATED = [/\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /^ui\/src\/wasm-pkg\//, /\.(wasm|png|jpg|ico|icns|woff2?)$/]
const RECORDS = [/(^|\/)CHANGELOG\.md$/, /(^|\/)changelog\.d\//]
const TESTS = [/\.test\./, /\.spec\./, /\/e2e\//, /(^|\/)tests\//]

/** `files`: [{path, added, deleted}]. Counts code only; reports whether a test was touched. */
export function sizeReport(files) {
  let lines = 0
  let touchedTests = false
  for (const f of files) {
    if (TESTS.some((r) => r.test(f.path))) { touchedTests = true; continue }
    if (GENERATED.some((r) => r.test(f.path)) || RECORDS.some((r) => r.test(f.path))) continue
    lines += f.added + f.deleted
  }
  return { lines, warn: lines > SIZE_LIMIT, touchedTests }
}

/** Parse `git diff --numstat` output (binary files show "-"). */
export function parseNumstat(text) {
  return text.split('\n').filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t')
    return { path: p.join('\t'), added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d) }
  })
}

/** From pre-push stdin (`<lref> <lsha> <rref> <rsha>`): the REMOTE branch names being pushed.
 *  Deletions (local sha all zeros) and non-branch refs are ignored. */
export function remoteBranchesToCheck(stdin) {
  const out = []
  for (const l of stdin.split('\n')) {
    const [, lsha, rref] = l.trim().split(/\s+/)
    if (!rref || !rref.startsWith('refs/heads/') || /^0+$/.test(lsha)) continue
    out.push(rref.slice('refs/heads/'.length))
  }
  return out
}

function report(name, { sameRepo = true, base, head = 'HEAD' } = {}) {
  let failed = false
  const why = branchProblem(name, { sameRepo })
  if (why) { console.error(`Branch name "${name}": ${why}`); failed = true }
  if (base && !/^(staging|main|release\/|pre-release\/)/.test(name)) {
    try {
      const files = parseNumstat(execSync(`git diff --numstat ${base} ${head}`, { encoding: 'utf8' }))
      const r = sizeReport(files)
      if (r.warn) {
        const msg = `${r.lines} lines of code outside tests, generated files and changelogs (limit ${SIZE_LIMIT}); ${r.touchedTests ? 'tests were touched' : 'no test was touched'}. Consider splitting.`
        console.log(`::warning::${msg}`)
        if (process.env.GITHUB_STEP_SUMMARY) {
          execSync(`cat >> "$GITHUB_STEP_SUMMARY"`, { input: `### PR size\n${msg}\n`, shell: '/bin/sh' })
        }
      }
    } catch { console.error('Size check skipped: base reference not available.') }
  }
  return failed
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2)
  const arg = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined }
  if (cmd === 'check') {
    // Values come from the workflow's env, never interpolated into a shell line.
    const failed = report(arg('--branch'), {
      sameRepo: arg('--same-repo') !== 'false', base: arg('--base'), head: arg('--head') ?? 'HEAD',
    })
    process.exit(failed ? 1 : 0)
  }
  if (cmd === 'pre-push') {
    const input = await new Promise((r) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { s += c }); process.stdin.on('end', () => r(s)) })
    let failed = false
    const base = process.env.KONCLAVE_PRE_PUSH_SKIP_DIFF ? undefined : arg('--base')
    for (const b of remoteBranchesToCheck(input)) failed = report(b, { base }) || failed
    process.exit(failed ? 1 : 0)
  }
  console.error('usage: pr-rules.mjs check --branch B [--same-repo true|false] [--base REF] | pre-push [--base REF]')
  process.exit(2)
}
