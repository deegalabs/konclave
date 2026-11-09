// The ONE reader of a changelog's structure. release.mjs, weekly-update.mjs, the shape test and the
// released-sections lock all read through here: four private parsers for one format is how a rule
// ends up implemented twice with only one copy fixed.
//
// The lock asks WHERE, never WHAT: a numbered section already released must be the same after the
// change as before (blank lines and trailing spaces aside). It never judges the prose.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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
// ---- Release bodies: what the GitHub release says, and the docs page built from the same text ----

/** The changelogs a release body is assembled from, in order, with the label each part gets.
 *  `helper-server/CHANGELOG.md` is the coordinator's own and is not a release of the app. */
export const RELEASE_SOURCES = [
  ['ui/CHANGELOG.md', 'The app'],
  ['CHANGELOG.md', 'The desktop shell and shared parts'],
]

/** An entry that opens "**Upgrading from" says what a member must do BEFORE running the installer,
 *  and a release body otherwise opens with whatever the app's changelog lists first. So each such
 *  entry is also printed at the top of the body, unbulleted, in the order found; it stays in its
 *  category below. A body with none is returned unchanged. */
export function upgradeFirst(body) {
  const lines = body.split('\n')
  const lifted = []
  lines.forEach((line, i) => {
    if (!line.startsWith('- **Upgrading from ')) return
    const entry = [line.slice(2)]
    for (let j = i + 1; j < lines.length && /^ {2}\S/.test(lines[j]); j++) entry.push(lines[j].trim())
    lifted.push(entry.join('\n'))
  })
  return lifted.length ? `${lifted.join('\n\n')}\n\n${body}` : body
}

/** The release body from `[label, body]` parts in RELEASE_SOURCES order. Labelled only when more
 *  than one part has anything to say: with a single part the body is that part alone, which keeps
 *  an older release body from changing shape. */
export function releaseBody(parts) {
  const present = parts.filter(([, body]) => body)
  if (present.length === 0) return ''
  if (present.length === 1) return upgradeFirst(present[0][1])
  return upgradeFirst(present.map(([label, body]) => `## ${label}\n\n${body}`).join('\n\n'))
}

/** A release body as the docs' blocks: `##` a heading, `###` a subheading, a run of `- ` entries one
 *  list (an indented line continues its entry), `>` lines one note, anything else a paragraph. A
 *  blank line ends whatever was open. Inline marks (`**`, backticks, links) are left for the page. */
export function notesBlocks(body) {
  const out = []
  let open = null
  const close = () => { open = null }
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) { close(); continue }
    if (line.startsWith('### ')) { close(); out.push({ k: 'h3', t: line.slice(4).trim() }); continue }
    if (line.startsWith('## ')) { close(); out.push({ k: 'h', t: line.slice(3).trim() }); continue }
    if (line.startsWith('- ')) {
      if (open?.k !== 'ul') { open = { k: 'ul', items: [] }; out.push(open) }
      open.items.push(line.slice(2).trim())
      continue
    }
    if (line.startsWith('>')) {
      const text = line.replace(/^>\s?/, '').trim()
      if (open?.k !== 'note') { open = { k: 'note', t: text }; out.push(open) } else open.t += ` ${text}`
      continue
    }
    if (open?.k === 'ul') { open.items[open.items.length - 1] += ` ${line.trim()}`; continue }
    if (open?.k === 'p') { open.t += ` ${line.trim()}`; continue }
    open = { k: 'p', t: line.trim() }
    out.push(open)
  }
  return out
}

/** Orders `x.y.z` versions; a missing part counts as 0 and a pre-release suffix is ignored. */
export function semverCompare(a, b) {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  return 0
}

/** The changelogs' text in RELEASE_SOURCES order; '' for a file that does not exist yet, which
 *  contributes nothing rather than failing a release. */
export function readReleaseSources(root = ROOT) {
  return RELEASE_SOURCES.map(([file]) => { try { return readFileSync(join(root, file), 'utf8') } catch { return '' } })
}

/** The versions this repo actually released. A section with no tag was cut and then superseded
 *  before it shipped, which is a thing that happens and must not silently swallow its entries.
 *  Null when git cannot be asked. */
export function taggedVersions(root = ROOT) {
  try {
    return new Set(
      execFileSync('git', ['tag'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')
        .map((t) => t.trim().replace(/^v/, ''))
        .filter(Boolean),
    )
  } catch {
    // No git, no tags: "cannot tell", which reports the single section. Never MORE than asked for.
    return null
  }
}

// The root changelog has every version's heading, so it is the one the walk below reads.
const ROOT_CHANGELOG = RELEASE_SOURCES.findIndex(([file]) => file === 'CHANGELOG.md')

/**
 * `version`, plus any section beneath it that was never tagged.
 *
 * A release body has to describe what the INSTALLER contains, not what its own section says. When
 * 0.5.0 was cut and then superseded before publication, a v0.6.0 body built from its own section
 * alone would have described 11 entries while the installer carried 42 - and nine `Security`
 * entries from the orphaned section would have shipped unannounced.
 *
 * Walking DOWN and stopping at the first tagged version is self-correcting: in the normal case the
 * previous release is tagged, the walk stops immediately, and this returns exactly one version.
 *
 * `tagged` is a parameter so a test can state which versions shipped instead of inheriting the
 * answer from the machine it runs on. The tests read the machine's tags until #573, which is how
 * they passed on a laptop and failed in CI. `md` is the root changelog's text.
 */
export function versionsToReport(version, tagged = taggedVersions(), md = readReleaseSources()[ROOT_CHANGELOG]) {
  // "Cannot tell" is wider than "git is missing". A shallow checkout has git and NO tags, and the
  // release workflow's has at most the tag being released - an empty answer, not an error. With no
  // earlier tag to stop at, the walk would report every section in the file: the whole history, as
  // one release's notes. With nothing beneath this version tagged, nothing says what shipped before
  // it, so the rule is the one written above: never more than asked for when we cannot tell.
  //
  // The question is whether a version BENEATH this one is tagged, not whether any other tag
  // exists. A release candidate, a tag that is not a version at all, or a newer release when an old
  // tag is rebuilt are all "another tag", and none of them is a place for the walk to stop.
  if (!tagged) return [version]
  const all = versionsIn(md)
  const start = all.indexOf(version)
  if (start === -1) return [version]
  const beneath = all.slice(start + 1)
  if (!beneath.some((v) => tagged.has(v))) return [version]
  const out = [version]
  for (const v of beneath) {
    if (tagged.has(v)) break
    out.push(v)
  }
  return out
}

/**
 * The release body for `version`: the GitHub release's text and the docs page's, from one place.
 * `mds` is the changelogs' text in RELEASE_SOURCES order.
 *
 * It covers every section `versionsToReport` names. A version not yet cut in ANY changelog reads
 * each one's [Unreleased] with its fragments, which is what `--notes` shows before a release. A
 * version that IS cut reads only its sections: a changelog with no section for it (the app's has
 * none before 0.5.0) contributes nothing, rather than its [Unreleased].
 */
export function releaseBodyFor(version, mds, tagged = taggedVersions(), root = ROOT) {
  const cut = mds.some((md) => hasSection(md, version))
  const versions = versionsToReport(version, tagged, mds[ROOT_CHANGELOG])
  const part = (md, file, v) => (hasSection(md, v) ? sectionBody(md, v) : cut ? '' : unreleasedOf(md, join(root, file)))
  return releaseBody(RELEASE_SOURCES.map(([file, label], i) => [
    label,
    versions.map((v) => part(mds[i] ?? '', file, v)).filter(Boolean).join('\n\n'),
  ]))
}

/** One page per RELEASED version, newest first: {version, date, blocks}, the body being exactly the
 *  GitHub release's (`releaseBodyFor`). A section that was never tagged has no page; its entries are
 *  on the page of the release that shipped them. With no tags to go by there are no pages, rather
 *  than a page per section that would say less than the release did. The date is the one on the
 *  app's heading (`## [0.18.0] 2026-11-08`), or the shell's when the app has none. */
export function releasePages(mds, tagged = taggedVersions()) {
  if (!tagged) return []
  const versions = [...new Set(mds.flatMap(versionsIn))].filter((v) => tagged.has(v)).sort((a, b) => semverCompare(b, a))
  return versions.map((version) => {
    const heading = mds.map((md) => parseSections(md).find((s) => s.version === version)?.heading ?? '').join(' ')
    const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(heading)?.[1] ?? ''
    return { version, date, blocks: notesBlocks(releaseBodyFor(version, mds, tagged)) }
  })
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
