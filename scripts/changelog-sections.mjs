// The ONE reader of a changelog's structure. release.mjs, weekly-update.mjs, the shape test and the
// released-sections lock all read through here: four private parsers for one format is how a rule
// ends up implemented twice with only one copy fixed.
//
// The lock asks WHERE, never WHAT: a numbered section already released must be the same after the
// change as before (blank lines and trailing spaces aside). It never judges the prose.
import { pathToFileURL } from 'node:url'
import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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

/** Whether the file has a section with this version (an EMPTY section still counts). */
export function hasSection(md, version) {
  return parseSections(md).some((s) => s.version === version)
}

/** One section's body, or '' when absent. */
export function sectionBody(md, version) {
  return parseSections(md).find((s) => s.version === version)?.body ?? ''
}

/** Numbered versions (not Unreleased) in file order, newest first. */
export function versionsIn(md) {
  return parseSections(md).filter((s) => /^\d+\.\d+\.\d+/.test(s.version)).map((s) => s.version)
}

// Lines are trimmed and blank runs collapsed on purpose: the lock asks WHERE a released section changed, not
// how it is laid out. The cost is known: a change of indentation (`- x` to `  - x`, which nests the markdown)
// passes, and so does the indentation inside an indented code block.
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

const HEADING = { security: 'Security', added: 'Added', changed: 'Changed', fixed: 'Fixed', 'known-limits': 'Known limits' }

/** Where a changelog's fragments live: `changelog.d/` beside the file. */
export const fragmentDirOf = (changelog) => changelog.replace(/CHANGELOG\.md$/, 'changelog.d')

/** null when `path` + `body` make a valid fragment: `<dir>/<category>/<slug>.md`, a bullet body. */
export function fragmentProblem(path, body) {
  const m = /(?:^|\/)changelog\.d\/([^/]+)\/[^/]+\.md$/.exec(path)
  if (!m || !CATEGORIES.includes(m[1])) return `"${path}" is not <changelog.d>/<${CATEGORIES.join('|')}>/<slug>.md`
  if (!body.trim()) return 'the fragment is empty'
  if (!body.trimStart().startsWith('- ')) return 'the fragment body must start with "- "'
  return null
}

/** The fragments under one changelog.d directory, sorted by category order then file name. */
export function readFragments(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const category of CATEGORIES) {
    const cd = join(dir, category)
    if (!existsSync(cd)) continue
    for (const f of readdirSync(cd).filter((x) => x.endsWith('.md')).sort()) {
      out.push({ category, name: f.replace(/\.md$/, ''), path: join(cd, f), body: readFileSync(join(cd, f), 'utf8').trim() })
    }
  }
  return out
}

/** `md` with the fragments folded into `[Unreleased]`, under the right `###` in canonical order. */
export function mergeFragments(md, frags) {
  if (!frags.length) return md
  const lines = md.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'))
  if (start === -1) return md
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith('## ')) { end = i; break }
  let inner = lines.slice(start + 1, end).join('\n').trim()
  let trailer = ''
  const t = /\n*(-{3,})$/.exec(inner)
  if (t) { trailer = t[1]; inner = inner.slice(0, t.index).trim() }
  const parts = inner.split(/^### /m)
  const pre = parts.shift().trim()
  const blocks = parts.map((p) => { const nl = p.indexOf('\n'); return { head: (nl < 0 ? p : p.slice(0, nl)).trim(), body: (nl < 0 ? '' : p.slice(nl + 1)).trim() } })
  const rank = (h) => { const i = Object.values(HEADING).indexOf(h); return i < 0 ? 99 : i }
  for (const f of [...frags].sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name))) {
    const h = HEADING[f.category]
    let b = blocks.find((x) => x.head === h)
    if (!b) {
      b = { head: h, body: '' }
      const at = blocks.findIndex((x) => rank(x.head) > rank(h))
      blocks.splice(at < 0 ? blocks.length : at, 0, b)
    }
    b.body = b.body ? `${b.body}\n${f.body.trim()}` : f.body.trim()
  }
  const text = [pre, ...blocks.map((b) => `### ${b.head}\n\n${b.body}`)].filter(Boolean).join('\n\n')
  const rebuilt = ['## [Unreleased]', '', text, ...(trailer ? ['', trailer] : []), ''].join('\n')
  return [...lines.slice(0, start), rebuilt, ...lines.slice(end)].join('\n')
}

/** What a changelog says is coming: its [Unreleased] section with the per-PR fragments beside it folded
 *  in. The one reader of "what is unreleased", for the release notes and the weekly material alike. */
export function unreleasedOf(md, file) {
  return sectionBody(mergeFragments(md, readFragments(fragmentDirOf(file))), 'Unreleased')
}

/** Cut-time: the `## [Unreleased]` heading replaced by `replacement` (the new empty Unreleased plus the
 *  version's heading). Kept here so the heading is parsed in one file. */
export function replaceUnreleasedHeading(md, replacement) {
  return md.replace(/^## \[Unreleased\]/m, replacement)
}

/** Cut-time: fold the fragments into the file and delete them. Returns how many were compiled. */
export function compileFragments(file, dir) {
  const frags = readFragments(dir)
  if (!frags.length) return 0
  writeFileSync(file, mergeFragments(readFileSync(file, 'utf8'), frags))
  for (const f of frags) rmSync(f.path)
  return frags.length
}

// CLI: node scripts/changelog-sections.mjs lock --branch B [--base REF=HEAD^1] file...
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
