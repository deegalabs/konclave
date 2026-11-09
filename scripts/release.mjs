#!/usr/bin/env node
// One source of version truth. Two modes:
//
//   node scripts/release.mjs <version>      Rename the CHANGELOG's `Unreleased` section to
//                                           <version>, dated, and bump ui/package.json +
//                                           src-tauri/tauri.conf.json to match.
//   node scripts/release.mjs --notes <ver>  Print the CHANGELOG section for <ver> (used by CI to
//                                           build the desktop release notes), then the commits
//                                           since the previous release grouped by type (git-cliff,
//                                           cliff.toml). Falls back to Unreleased.
//
// After a bump: commit, then `git tag v<version> && git push --tags` — the desktop-release workflow
// builds the installers and uses the printed notes as the release body. Vercel deploys the web from
// the same commit, so the in-app version badge, the desktop installer, and the tag all agree.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { hasSection, versionsIn, fragmentDirOf, compileFragments, replaceUnreleasedHeading, RELEASE_SOURCES, releaseBodyFor, readReleaseSources, semverCompare, taggedVersions, versionsToReport } from './changelog-sections.mjs'
// Moved to the shared reader, where the docs' release pages read it too; still exported from here.
export { upgradeFirst, versionsToReport } from './changelog-sections.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = join(root, 'CHANGELOG.md')

// A desktop release ships the app AND the shell it runs in, so its notes are assembled from both
// files rather than picked from one. The web ships only the app, and ships it continuously - which
// is exactly why `ui/CHANGELOG.md` exists as its own file. The tension is real and deliberate: the
// two products share a UI, so an entry about the app reaches the web on merge and the desktop at
// the next tag. Recording it once, where the change lives, beats writing it twice.
// The list and its labels live in changelog-sections.mjs, which the docs' release pages read too.
const SOURCES = RELEASE_SOURCES.map(([file, label]) => [join(root, file), label])

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** The version headings in a changelog, in file order (newest first). */
function versionsFrom(file) {
  let md
  try { md = readFileSync(file, 'utf8') } catch { return [] }
  return versionsIn(md)
}

/** The commits a release's notes list: from the tag of the release before it (the first tagged
 *  version beneath the sections it reports, so a superseded section's commits come too) to this
 *  release's tag, or to HEAD before it is tagged. Null when no earlier release is known, which lists
 *  nothing rather than the whole history. */
export function commitRange(version, tagged = taggedVersions()) {
  if (!tagged) return null
  const reported = versionsToReport(version, tagged)
  const all = versionsFrom(CHANGELOG)
  const last = all.indexOf(reported[reported.length - 1])
  const previous = last === -1
    ? [...tagged].filter((v) => v !== version && semverLess(v, version)).sort(semverCompare).pop()
    : all.slice(last + 1).find((v) => tagged.has(v))
  if (!previous) return null
  return `v${previous}..${tagged.has(version) ? `v${version}` : 'HEAD'}`
}

const semverLess = (a, b) => semverCompare(a, b) < 0

/** The prose, then the commits under their own heading; the prose alone when there is no list. */
export function withCommits(prose, list) {
  const l = (list || '').trim()
  if (!l) return prose
  return `${prose}\n\n## Commits\n\n${l}`
}

/** The commit list for `version` from git-cliff (cliff.toml). In CI (the release workflow, which
 *  installs git-cliff pinned) a failure fails the notes, so a release body never loses its list
 *  without anyone seeing it; elsewhere the notes keep the prose and say why on stderr. */
export function commitList(version, {
  run = (args) => execFileSync('git-cliff', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  ci = !!process.env.CI,
  tagged = taggedVersions(),
  warn = (m) => console.error(m),
} = {}) {
  const range = commitRange(version, tagged)
  if (!range) return ''
  try {
    return run(['--config', join(root, 'cliff.toml'), '--strip', 'all', range])
  } catch (e) {
    const why = e.code === 'ENOENT'
      ? 'git-cliff is not installed'
      : (String(e.stderr || '').split('\n').find((l) => l.trim()) || String(e.message).split('\n')[0])
    if (ci) throw new Error(`release notes: no commit list for ${range}: ${why}`)
    warn(`release notes: no commit list (${why})`)
    return ''
  }
}

/** The release body for `version` (or what is unreleased, with no version): the one function the
 *  docs' release pages read too, so the two never say different things. */
function notes(version) {
  return releaseBodyFor(version, readReleaseSources(root))
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [arg, arg2] = process.argv.slice(2)

  if (arg === '--notes') {
    const v = arg2 && arg2.replace(/^v/, '')
    process.stdout.write(withCommits(notes(v), v ? commitList(v) : '') + '\n')
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
    if (hasSection(md, version)) return false
    // A source with nothing unreleased is skipped, not fatal. The shell can be untouched for a
    // release that is all app, and the reverse happens too.
    if (!hasSection(md, 'Unreleased')) return false
    // Fold the per-PR fragments into the file first, under the right headings, and delete them.
    compileFragments(file, fragmentDirOf(file))
    md = readFileSync(file, 'utf8')
    const day = new Date().toISOString().slice(0, 10)
    const head = `## [Unreleased]\n\n## [${version}] ${day}` + (note ? `\n\n${note}` : '')
    writeFileSync(file, replaceUnreleasedHeading(md, head))
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
