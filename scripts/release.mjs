#!/usr/bin/env node
// One source of version truth. Two modes:
//
//   node scripts/release.mjs <version>      Rename the CHANGELOG's `Unreleased` section to
//                                           <version>, dated, and bump ui/package.json +
//                                           src-tauri/tauri.conf.json to match.
//   node scripts/release.mjs --notes <ver>  Print the CHANGELOG section for <ver> (used by CI to
//                                           build the desktop release notes). Falls back to Unreleased.
//
// After a bump: commit, then `git tag v<version> && git push --tags` — the desktop-release workflow
// builds the installers and uses the printed notes as the release body. Vercel deploys the web from
// the same commit, so the in-app version badge, the desktop installer, and the tag all agree.
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = join(root, 'CHANGELOG.md')
const UI_CHANGELOG = join(root, 'ui', 'CHANGELOG.md')

// A desktop release ships the app AND the shell it runs in, so its notes are assembled from both
// files rather than picked from one. The web ships only the app, and ships it continuously - which
// is exactly why `ui/CHANGELOG.md` exists as its own file. The tension is real and deliberate: the
// two products share a UI, so an entry about the app reaches the web on merge and the desktop at
// the next tag. Recording it once, where the change lives, beats writing it twice.
const SOURCES = [
  [UI_CHANGELOG, 'The app'],
  [CHANGELOG, 'The desktop shell and shared parts'],
]

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// Return one file's body under `## [<version>]` (or `## [Unreleased]`), without the heading.
function sectionOf(file, version) {
  let md
  // A source that does not exist yet contributes nothing rather than failing the release. Cutting a
  // release is the worst moment to discover a missing file.
  try { md = readFileSync(file, 'utf8') } catch { return '' }
  const lines = md.split('\n')
  const head = (s) => s.startsWith('## ')
  let start = lines.findIndex((l) => head(l) && l.includes(`[${version}]`))
  if (start === -1) start = lines.findIndex((l) => head(l) && l.includes('[Unreleased]'))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (head(lines[i])) { end = i; break }
  // Trim the `---` that separates versions in the file: it belongs to the CHANGELOG's layout,
  // not to this release, and it rendered as a stray rule at the foot of the GitHub release body.
  return lines.slice(start + 1, end).join('\n').trim().replace(/\n*-{3,}$/, '').trimEnd()
}

/** The versions this repo actually released, newest first. A section with no tag was cut and then
 *  superseded before it shipped, which is a thing that happens and must not silently swallow its
 *  entries. */
function taggedVersions() {
  try {
    return new Set(
      execSync('git tag', { encoding: 'utf8' })
        .split('\n')
        .map((t) => t.trim().replace(/^v/, ''))
        .filter(Boolean),
    )
  } catch {
    // No git, no tags: fall back to "everything is released", which prints the single section -
    // the behaviour before this existed. Never MORE than asked for when we cannot tell.
    return null
  }
}

/** The version headings in a changelog, in file order (newest first). */
function versionsIn(file) {
  let md
  try { md = readFileSync(file, 'utf8') } catch { return [] }
  return [...md.matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map((m) => m[1])
}

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
 */
export function versionsToReport(version) {
  const tagged = taggedVersions()
  if (!tagged) return [version]
  const all = versionsIn(CHANGELOG)
  const start = all.indexOf(version)
  if (start === -1) return [version]
  const out = [version]
  for (const v of all.slice(start + 1)) {
    if (tagged.has(v)) break
    out.push(v)
  }
  return out
}

/**
 * Every source's section for `version`, assembled.
 *
 * Labelled only when more than one source has anything to say. With a single source the output is
 * byte-identical to what this printed before the split, which is what keeps an existing desktop
 * release body from changing shape for a reason nobody asked for.
 */
function notes(version) {
  const versions = versionsToReport(version)
  const parts = SOURCES
    .map(([file, label]) => [label, versions.map((v) => sectionOf(file, v)).filter(Boolean).join('\n\n')])
    .filter(([, body]) => body)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0][1]
  return parts.map(([label, body]) => `## ${label}\n\n${body}`).join('\n\n')
}

function bumpJson(path, version) {
  const j = JSON.parse(readFileSync(path, 'utf8'))
  j.version = version
  writeFileSync(path, JSON.stringify(j, null, 2) + '\n')
}

// tauri.conf.json is JSON but we only touch the top-level "version" to preserve formatting/comments.
function bumpTauri(path, version) {
  const src = readFileSync(path, 'utf8')
  const m = /("version"\s*:\s*")([^"]*)(")/.exec(src)
  // An unchanged file used to throw `could not find a top-level "version"`, which was wrong twice
  // over: it HAD found it, and the reason nothing changed was that the version was already right.
  // Re-running a release must be a no-op, not a crash that leaves package.json bumped and this one
  // not - the state a half-applied release leaves behind is worse than either end of it.
  if (!m) throw new Error(`could not find a top-level "version" in ${path}`)
  if (m[2] === version) return
  writeFileSync(path, src.replace(m[0], `${m[1]}${version}${m[3]}`))
}

// WHICH SERVICES WERE LIVE WHEN THIS WAS CUT.
//
// Asked for as an audit question and it had no answer: the web app is whatever `main` is, the
// desktop is whatever the tag is, and the coordinator and relay are whatever someone last pushed by
// hand. Reconstructing that months later is guesswork, and the services do not carry a version to
// guess FROM - by design, because a number nobody bumps lies.
//
// They do each report a build identity, so the release records what they were ANSWERING at the
// moment it was cut. Not what they should have been: what they were.
const SERVICES = [
  ['coordinator', 'https://konclave-helper-production.up.railway.app/api/health', (j) => j.helper_commit],
  ['relay', 'https://konclave-relay-production.up.railway.app/health', (j) => j.source_digest],
]

/**
 * Ask each service what it is running.
 *
 * A service that cannot be reached is recorded as `unreachable`, never omitted and never guessed.
 * An audit line that silently drops the half nobody could check is worse than one that says so -
 * and a release must not fail because a deploy target is having a bad minute.
 */
async function serviceBuilds() {
  return Promise.all(SERVICES.map(async ([name, url, pick]) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!r.ok) return [name, `unreachable (HTTP ${r.status})`]
      const v = pick(await r.json())
      return [name, v || 'unreachable (no build identity in the reply)']
    } catch {
      return [name, 'unreachable']
    }
  }))
}

/** The line written into the cut section. Kept to one paragraph: it is a record, not a report. */
export function buildsNote(builds, day) {
  const parts = builds.map(([n, v]) => `${n} \`${v}\``).join(', ')
  return [
    `> **Services deployed when this was cut (${day}):** ${parts}.`,
    '> The web app is this release\'s own commit. The two services are deployed by hand and may be',
    '> older than it - recording what they were ANSWERING is the point, not what they should have been.',
    '',
  ].join('\n')
}

// Only when RUN, never when imported. A test that imports this to check one pure function must
// not trip the argument parsing and call `process.exit` on the way in.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [arg, arg2] = process.argv.slice(2)

  if (arg === '--notes') {
    process.stdout.write(notes(arg2 && arg2.replace(/^v/, '')) + '\n')
    process.exit(0)
  }

  const version = (arg || '').replace(/^v/, '')
  if (!semver.test(version)) {
    console.error('usage: node scripts/release.mjs <version>   (e.g. 0.3.0)')
    console.error('       node scripts/release.mjs --notes <version>')
    process.exit(1)
  }

  // CHANGELOG.md said this script renames `Unreleased`, and it did not: it checked, failed, and left
  // the rename to whoever read the error. A doc promising a step nobody performs is how the section
  // ends up dated by hand, dated wrong, or not at all - so the script now does what the file claims.
  // Cutting a release is exactly when nobody wants a second thing to remember.
  function cutOne(file, version, note = '') {
    let md
    try { md = readFileSync(file, 'utf8') } catch { return false }
    // Already cut: re-running must be a no-op, not a second empty section.
    if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(md)) return false
    // A source with nothing unreleased is skipped, not fatal. The shell can be untouched for a
    // release that is all app, and the reverse happens too.
    if (!/^## \[Unreleased\]/m.test(md)) return false
    const day = new Date().toISOString().slice(0, 10)
    const head = `## [Unreleased]\n\n## [${version}] ${day}` + (note ? `\n\n${note}` : '')
    writeFileSync(file, md.replace(/^## \[Unreleased\]/m, head))
    return true
  }

  function cutSection(version, note) {
    // The record goes in the ROOT file only. It describes the release, not the app - repeating it in
    // every changelog would be four copies of one fact, which is the shape this repo keeps paying for.
    return SOURCES.map(([file]) => cutOne(file, version, file === CHANGELOG ? note : '')).some(Boolean)
  }

  // Read BEFORE the cut: `notes` falls back to Unreleased, which is what this version's body still is.
  const section = notes(version)
  if (!section) {
    console.error('No changelog has a "## [Unreleased]" section with anything in it.')
    console.error('A release with no entries is a release nobody can read.')
    process.exit(1)
  }
  const day = new Date().toISOString().slice(0, 10)
  const builds = await serviceBuilds()
  for (const [n, v] of builds) console.log(`  ${n}: ${v}`)
  const cut = cutSection(version, buildsNote(builds, day))

  bumpJson(join(root, 'ui', 'package.json'), version)
  bumpTauri(join(root, 'src-tauri', 'tauri.conf.json'), version)

  console.log(cut
    ? `Cut CHANGELOG [Unreleased] to [${version}], and bumped ui/package.json and src-tauri/tauri.conf.json.`
    : `CHANGELOG already has [${version}]; bumped ui/package.json and src-tauri/tauri.conf.json.`)
  console.log('Next:')
  console.log(`  git commit -am "release: v${version}"`)
  console.log(`  git tag v${version} && git push origin main --tags`)
}
