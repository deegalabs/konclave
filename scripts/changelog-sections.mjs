// The ONE reader of a changelog's structure. release.mjs, weekly-update.mjs, the shape test and the
// released-sections lock all read through here: four private parsers for one format is how a rule
// ends up implemented twice with only one copy fixed.
//
// The lock asks WHERE, never WHAT: a numbered section already released must be the same after the
// change as before (blank lines and trailing spaces aside). It never judges the prose.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const CATEGORIES = ['security', 'added', 'changed', 'fixed', 'known-limits']

/** Every version section (`## [x]`) in file order: {title, version, body, heads}. Prose headings
 *  that do not start with `[` are not release bodies and are skipped. */
export function parseSections(md) {
  const out = []
  let cur = null
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      const title = line.slice(3).trim()
      const m = /^\[([^\]]+)\]/.exec(title)
      cur = m ? { title: m[1], version: m[1], heading: line, lines: [], heads: [] } : null
      if (cur) out.push(cur)
    } else if (cur) {
      cur.lines.push(line)
      if (line.startsWith('### ')) cur.heads.push(line.slice(4).trim())
    }
  }
  return out.map((s) => ({
    title: s.title, version: s.version, heading: s.heading, heads: s.heads,
    // The `---` that separates versions belongs to the file's layout, not to the release.
    body: s.lines.join('\n').trim().replace(/\n*-{3,}$/, '').trimEnd(),
  }))
}

/** One section's body, or '' when absent. */
export function sectionBody(md, version) {
  return parseSections(md).find((s) => s.version === version)?.body ?? ''
}

/** Numbered versions (not Unreleased) in file order, newest first. */
export function versionsIn(md) {
  return parseSections(md).filter((s) => /^\d+\.\d+\.\d+/.test(s.version)).map((s) => s.version)
}

const norm = (s) => s.split('\n').map((l) => l.trim()).join('\n').replace(/\n{2,}/g, '\n').trim()

/** Versions whose released section changed between `baseMd` and `headMd`.
 *  A new numbered section is allowed only from a release-cut branch. */
export function lockViolations(baseMd, headMd, { headBranch = '' } = {}) {
  const cutting = /^(pre-release|release|hotfix)\//.test(headBranch)
  const before = new Map(parseSections(baseMd).filter((s) => /^\d/.test(s.version)).map((s) => [s.version, s]))
  const after = new Map(parseSections(headMd).filter((s) => /^\d/.test(s.version)).map((s) => [s.version, s]))
  const bad = []
  for (const [v, s] of before) {
    const h = after.get(v)
    if (!h || norm(h.heading + '\n' + h.body) !== norm(s.heading + '\n' + s.body)) bad.push(v)
  }
  if (!cutting) for (const v of after.keys()) if (!before.has(v)) bad.push(v)
  return bad
}

// CLI: node scripts/changelog-sections.mjs lock --branch B [--base REF=HEAD^1] file...
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd !== 'lock') { console.error('usage: changelog-sections.mjs lock --branch B [--base REF] file...'); process.exit(2) }
  let branch = ''
  let baseRef = 'HEAD^1'
  const files = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--branch') branch = rest[++i]
    else if (rest[i] === '--base') baseRef = rest[++i]
    else files.push(rest[i])
  }
  let failed = false
  for (const f of files) {
    let baseMd = ''
    try { baseMd = execFileSync('git', ['show', `${baseRef}:${f}`], { encoding: 'utf8' }) } catch { continue }
    let headMd = ''
    try { headMd = readFileSync(f, 'utf8') } catch { headMd = '' }
    const bad = lockViolations(baseMd, headMd, { headBranch: branch })
    if (bad.length) {
      failed = true
      console.error(`${f}: released section(s) changed: ${bad.join(', ')}`)
    }
  }
  if (failed) {
    console.error('A released section is not edited by a normal change: its entries go under [Unreleased].')
    console.error('If the amendment is deliberate, add the "changelog-amend" label and say why in the PR.')
    process.exit(1)
  }
  console.log('Released changelog sections are untouched.')
}
