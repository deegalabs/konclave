#!/usr/bin/env node
// Gather the material for the weekly forum update (#57218).
//
//   node scripts/weekly-update.mjs                          the last 7 days
//   node scripts/weekly-update.mjs --since 2026-08-27        an explicit window
//   node scripts/weekly-update.mjs --since 2026-08-27 --until 2026-09-07
//
// It gathers, it does not write. The prose is a judgement call about what mattered and belongs to a
// person; what shipped is a fact, and reconstructing it from memory a week later is how "what was
// the hole, and was I exposed?" quietly becomes "improved security". So this answers only the
// mechanical half: which PRs merged, which txids the proof file gained, which tags were cut, and
// what is staged under CHANGELOG's Unreleased.
//
// The same argument as the changelog CI gate, one level up: the update stops depending on anyone
// remembering.
//
// Needs `gh` authenticated. In Actions that is GITHUB_TOKEN.
//
// This lives in the repo and its SessionStart hook does not, deliberately. The hook is the
// maintainer's cadence and firing it on someone else's clone would be a surprise; this file is just
// a reader of public facts - merged PRs, the txids in docs/PROOF.md, the tags, and what is staged
// under CHANGELOG's Unreleased. It was in a gitignored folder until 2026-09-08, which meant the one
// tool built so the update would not depend on anyone remembering was itself one clone away from
// being forgotten.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// `--posted` moves the window. Deliberately a separate act from generating the material: the hook
// never advances it, so a week that did not get posted is still there next time.
if (process.argv.includes('--posted')) {
  const { writeFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const stamp = join(dirname(dirname(fileURLToPath(import.meta.url))), '.weekly-update-stamp')
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(stamp, day + '\n')
  console.log(`Window moved: the next weekly update starts at ${day}.`)
  process.exit(0)
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const iso = (d) => d.toISOString().slice(0, 10)
const until = arg('until', iso(new Date()))
const since = arg('since', iso(new Date(Date.parse(until) - 7 * 864e5)))

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 << 20 }).trim()

/** Merged PRs in the window, newest last so the list reads forwards. */
function mergedPrs() {
  const raw = sh('gh', [
    'pr', 'list', '--state', 'merged', '--limit', '400',
    '--json', 'number,title,mergedAt',
  ])
  return JSON.parse(raw)
    .filter((p) => p.mergedAt.slice(0, 10) >= since && p.mergedAt.slice(0, 10) <= until)
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))
}

// Conventional-commit scope is the closest thing the repo has to an area, and it is already there.
// Anything unprefixed lands in "other" rather than being guessed at: the repo adopted the prefixes
// partway through, so the early PRs have no scope to read and inventing one would be worse.
function area(title) {
  const m = /^(\w+)(?:\(([^)]+)\))?:/.exec(title)
  if (!m) return 'other'
  const [, type, scope] = m
  if (type === 'docs') return 'docs'
  if (type === 'ci' || type === 'chore') return 'ci/chore'
  if (type === 'test') return 'tests'
  return scope || type
}

/** The txids in docs/PROOF.md at a point in time. A 64-hex string in that file IS a txid. */
function txidsAt(rev) {
  const body = rev ? sh('git', ['show', `${rev}:docs/PROOF.md`]) : readFileSync('docs/PROOF.md', 'utf8')
  return new Set(body.match(/\b[0-9a-f]{64}\b/g) ?? [])
}

/** The line describing a txid, so a new entry arrives with what it proves attached. */
function claimFor(txid) {
  const line = readFileSync('docs/PROOF.md', 'utf8')
    .split('\n')
    .find((l) => l.includes(txid) && l.includes('**'))
  if (!line) return '(no claim line found in PROOF.md)'
  return (/\*\*(.+?)\*\*(.*)/.exec(line) ?? [, '', ''])
    .slice(1, 3)
    .join('')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
}

function unreleased() {
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n')
  const s = lines.findIndex((l) => l.startsWith('## [Unreleased]'))
  if (s === -1) return ''
  let e = lines.length
  for (let i = s + 1; i < lines.length; i++) if (lines[i].startsWith('## ')) { e = i; break }
  return lines.slice(s + 1, e).join('\n').trim()
}

const prs = mergedPrs()
const byArea = new Map()
for (const p of prs) {
  const a = area(p.title)
  if (!byArea.has(a)) byArea.set(a, [])
  byArea.get(a).push(p)
}

// The last commit that touched PROOF.md before the window opened is the honest baseline: comparing
// against `since` itself would miss a file that had not changed that day.
const base = sh('git', ['log', '--format=%H', `--before=${since}`, '-1', '--', 'docs/PROOF.md'])
const before = base ? txidsAt(base) : new Set()
const now = txidsAt(null)
const gained = [...now].filter((t) => !before.has(t))

const tags = sh('git', ['tag', '--sort=-creatordate', '--format=%(refname:short) %(creatordate:short)'])
  .split('\n')
  .filter((l) => { const d = l.split(' ')[1]; return d >= since && d <= until })

const out = []
out.push(`# Weekly update material: ${since} to ${until}`)
out.push('')
out.push(`${prs.length} pull requests merged. ${before.size} to ${now.size} verifiable mainnet txids.`)
out.push(tags.length ? `Tags cut: ${tags.join(', ')}.` : 'No tag cut this period.')
out.push('')
out.push('> Gathered, not written. Decide what MATTERED, group it by what a member would notice,')
out.push('> and drop everything they would not. Then verify the counts with `verify-proof.mjs`')
out.push('> before publishing a number.')
out.push('')

if (gained.length) {
  out.push('## New mainnet proof')
  out.push('')
  for (const t of gained) out.push(`- \`${t.slice(0, 8)}\` ${claimFor(t)}`)
  out.push('')
}

const staged = unreleased()
if (staged) {
  out.push('## Staged to announce (CHANGELOG, Unreleased)')
  out.push('')
  out.push(staged)
  out.push('')
}

out.push('## Merged, by area')
out.push('')
for (const [a, list] of [...byArea].sort((x, y) => y[1].length - x[1].length)) {
  out.push(`### ${a} (${list.length})`)
  out.push('')
  for (const p of list) out.push(`- #${p.number} ${p.title}`)
  out.push('')
}

process.stdout.write(out.join('\n') + '\n')
