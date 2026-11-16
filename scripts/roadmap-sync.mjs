#!/usr/bin/env node
// roadmap-sync.mjs - what GitHub says about each issue and pull request the public roadmap cites.
// Reading the docs must make no call to GitHub (no third party learns who reads them), so this reads
// GitHub instead and writes ui/src/docs/roadmap-refs.ts (title and state per ref), committed and baked in.
//
//   node scripts/roadmap-sync.mjs           rewrite the file from GitHub
//   node scripts/roadmap-sync.mjs --check   write nothing; exit 1 and print what differs
//   ... --check --max-age-days N           also fail if the file's date is more than N days old
//
// The refs, the repository and each link come from ui/src/docs/roadmap.ts, imported as a module (one
// list, one URL rule). Token: GITHUB_TOKEN, else `gh auth token`, else anonymous (under 60 calls/hour).
// When a state changes, the script names the steps that cite it: re-read those texts in the same change,
// or a badge saying "Closed" sits next to a sentence saying "not closed".

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { REPO, ROADMAP_LISTS, refUrl } from '../ui/src/docs/roadmap.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const OUT = 'ui/src/docs/roadmap-refs.ts'

const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The refs of every list of stages, in page order, each once. */
export function refKeysOf(stageLists) {
  const seen = new Set()
  const out = []
  for (const list of stageLists) {
    for (const stage of list) {
      for (const r of stage.refs) {
        const key = `${r.kind}:${r.n}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ kind: r.kind, n: r.n, key })
      }
    }
  }
  return out
}

// The link GitHub gives must be the one the page shows (refUrl), so a transferred issue or a renamed
// repository fails here instead of linking somewhere else.
function checked(json, r) {
  const key = `${r.kind}:${r.n}`
  if (!json || json.number !== r.n) throw new Error(`${key}: GitHub answered for number ${json?.number}`)
  if (json.html_url !== refUrl(r)) throw new Error(`${key}: unexpected url ${json.html_url}`)
  if (typeof json.title !== 'string' || json.title.trim() === '') throw new Error(`${key}: empty title`)
}

/** An issue's title and state, from GET /repos/{repo}/issues/{n}. */
export function issueInfo(json, n) {
  if (json?.pull_request) throw new Error(`issues/${n}: GitHub says this is a pull request; cite it as pull(${n})`)
  checked(json, { kind: 'issue', n })
  if (json.state === 'open') return { title: json.title, state: 'open' }
  if (json.state !== 'closed') throw new Error(`issues/${n}: unknown state ${json.state}`)
  if (json.state_reason === 'completed' || json.state_reason == null) return { title: json.title, state: 'closed' }
  if (json.state_reason === 'not_planned') return { title: json.title, state: 'not-planned' }
  throw new Error(`issues/${n}: closed as ${json.state_reason}; decide by hand what the page should say (duplicate is not "not planned")`)
}

/** A pull request's title and state, from GET /repos/{repo}/pulls/{n}. */
export function pullInfo(json, n) {
  checked(json, { kind: 'pull', n })
  if (json.merged_at) return { title: json.title, state: 'merged' }
  if (json.state === 'open') return { title: json.title, state: json.draft ? 'draft' : 'open' }
  if (json.state === 'closed') return { title: json.title, state: 'closed-unmerged' }
  throw new Error(`pull/${n}: unknown state ${json.state}`)
}

/** The day of GitHub's own Date header (UTC), in the shape the page shows. */
export function asOfFrom(dateHeader) {
  const t = dateHeader ? Date.parse(dateHeader) : NaN
  if (Number.isNaN(t)) throw new Error(`GitHub sent no usable Date header: ${dateHeader}`)
  const d = new Date(t)
  const day = d.getUTCDate()
  const m = d.getUTCMonth()
  const y = d.getUTCFullYear()
  return {
    iso: d.toISOString().slice(0, 10),
    'pt-BR': `${day} de ${MONTHS_PT[m]} de ${y}`,
    en: `${day} ${MONTHS_EN[m]} ${y}`,
  }
}

/** Whole days from one ISO day to another (both read as UTC midnight). */
export function ageInDays(fromIso, toIso) {
  const day = /^\d{4}-\d{2}-\d{2}$/
  if (!day.test(fromIso) || !day.test(toIso)) throw new Error(`not an ISO date: ${fromIso} / ${toIso}`)
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)
}

/** What is wrong with the committed date, or null: its words must be its day, it cannot be after GitHub's
 *  day (`todayIso`), and with `maxAge` it cannot be more than that many days older. */
export function dateProblem(fileAsOf, todayIso, maxAge) {
  const iso = fileAsOf?.iso
  const t = /^\d{4}-\d{2}-\d{2}$/.test(iso ?? '') ? Date.parse(`${iso}T12:00:00Z`) : NaN
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso) return `${iso} is not a date`
  if (JSON.stringify(asOfFrom(new Date(t).toUTCString())) !== JSON.stringify(fileAsOf)) return `the words of ${iso} do not match its day`
  const age = ageInDays(iso, todayIso)
  if (age < 0) return `${iso} is after GitHub's day, ${todayIso}`
  if (maxAge !== undefined && age > maxAge) return `${iso} is more than ${maxAge} days before GitHub's ${todayIso}`
  return null
}

/** The file's text. Titles go in as JSON, so nothing GitHub sends can become code. */
export function render(asOf, info) {
  const rows = [...info].map(([key, v]) => `  ${JSON.stringify(key)}: ${JSON.stringify({ title: v.title, state: v.state })}`)
  return `// GENERATED by scripts/roadmap-sync.mjs: do not edit by hand. Run \`node scripts/roadmap-sync.mjs\`.
// What GitHub said about each issue and pull request the public roadmap cites, on REFS_AS_OF. It is
// committed, so reading the docs makes no call to GitHub. A state is GitHub's: closed or merged there
// does not mean live in production.

export type RefState = 'open' | 'closed' | 'not-planned' | 'draft' | 'merged' | 'closed-unmerged'

export type RefInfo = { title: string; state: RefState }

/** The day GitHub was read (its own Date header, UTC). Not the day the step texts were re-read. */
export const REFS_AS_OF = ${JSON.stringify(asOf)}

export const REF_INFO: Record<string, RefInfo> = {
${rows.join(',\n')}
}
`
}

/** Every difference between the committed map and what GitHub says now, one line each. */
export function diffInfo(before, after) {
  const lines = []
  for (const [key, now] of after) {
    const was = before[key]
    if (!was) lines.push(`${key} is new`)
    else {
      if (was.state !== now.state) lines.push(`${key} state: ${was.state} -> ${now.state}`)
      if (was.title !== now.title) lines.push(`${key} title: ${JSON.stringify(was.title)} -> ${JSON.stringify(now.title)}`)
    }
  }
  for (const key of Object.keys(before)) if (!after.has(key)) lines.push(`${key} is no longer on the page`)
  return lines
}

/** Reads GitHub for every ref. Any failed read throws: a network error is never "nothing changed". */
export async function sync({ stages, fetchImpl = fetch, token }) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  if (token) headers.authorization = `Bearer ${token}`
  const info = new Map()
  let asOf = null
  for (const r of refKeysOf(stages)) {
    const url = `https://api.github.com/repos/${REPO}/${r.kind === 'pull' ? 'pulls' : 'issues'}/${r.n}`
    const res = await fetchImpl(url, { headers })
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    const json = await res.json()
    info.set(r.key, r.kind === 'pull' ? pullInfo(json, r.n) : issueInfo(json, r.n))
    asOf ??= asOfFrom(res.headers.get('date'))
  }
  if (!asOf) throw new Error('the roadmap cites no refs')
  return { asOf, info }
}

function tokenFromEnv() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

async function main(argv) {
  const check = argv.includes('--check')
  const ageFlag = argv.indexOf('--max-age-days')
  const maxAge = ageFlag === -1 ? undefined : Number(argv[ageFlag + 1])
  if (maxAge !== undefined && !(Number.isInteger(maxAge) && maxAge >= 0)) throw new Error('--max-age-days takes a whole number of days')
  const lists = ROADMAP_LISTS
  const { asOf, info } = await sync({ stages: lists, token: tokenFromEnv() })
  const current = await import(pathToFileURL(join(ROOT, OUT)).href).catch(() => ({ REF_INFO: {} }))
  const diff = diffInfo(current.REF_INFO, info)
  const changedStates = new Set(diff.filter((l) => l.includes(' state: ')).map((l) => l.split(' ')[0]))
  const toReread = lists.flat().filter((s) => s.refs.some((r) => changedStates.has(`${r.kind}:${r.n}`))).map((s) => s.id)
  for (const line of diff) console.log(line)
  if (toReread.length) console.log(`re-read the text of: ${toReread.join(', ')}`)
  if (check) {
    let file = ''
    try { file = readFileSync(join(ROOT, OUT), 'utf8') } catch { /* missing: the diff says so */ }
    if (current.REFS_AS_OF && file !== render(current.REFS_AS_OF, new Map(Object.entries(current.REF_INFO)))) {
      console.error(`${OUT} was edited by hand: run node scripts/roadmap-sync.mjs`)
      process.exit(1)
    }
    if (diff.length) {
      console.error(`${OUT} differs from GitHub: run node scripts/roadmap-sync.mjs`)
      process.exit(1)
    }
    const problem = dateProblem(current.REFS_AS_OF, asOf.iso, maxAge)
    if (problem) {
      console.error(`${OUT}: ${problem}. Run node scripts/roadmap-sync.mjs`)
      process.exit(1)
    }
    console.log(`${OUT} matches GitHub (${info.size} refs, read ${asOf.iso}; file dated ${current.REFS_AS_OF?.iso})`)
    return
  }
  const text = render(asOf, info)
  const path = join(ROOT, OUT)
  let old = ''
  try { old = readFileSync(path, 'utf8') } catch { /* first run */ }
  if (old !== text) writeFileSync(path, text)
  console.log(`${OUT}: ${info.size} refs, as of ${asOf.iso}${diff.length ? '' : ' (no change on GitHub)'}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
