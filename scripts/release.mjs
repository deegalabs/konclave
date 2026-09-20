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

/**
 * Every source's section for `version`, assembled.
 *
 * Labelled only when more than one source has anything to say. With a single source the output is
 * byte-identical to what this printed before the split, which is what keeps an existing desktop
 * release body from changing shape for a reason nobody asked for.
 */
function notes(version) {
  const parts = SOURCES
    .map(([file, label]) => [label, sectionOf(file, version)])
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
function cutOne(file, version) {
  let md
  try { md = readFileSync(file, 'utf8') } catch { return false }
  // Already cut: re-running must be a no-op, not a second empty section.
  if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(md)) return false
  // A source with nothing unreleased is skipped, not fatal. The shell can be untouched for a
  // release that is all app, and the reverse happens too.
  if (!/^## \[Unreleased\]/m.test(md)) return false
  const day = new Date().toISOString().slice(0, 10)
  writeFileSync(file, md.replace(/^## \[Unreleased\]/m, `## [Unreleased]\n\n## [${version}] ${day}`))
  return true
}

function cutSection(version) {
  return SOURCES.map(([file]) => cutOne(file, version)).some(Boolean)
}

// Read BEFORE the cut: `notes` falls back to Unreleased, which is what this version's body still is.
const section = notes(version)
if (!section) {
  console.error('No changelog has a "## [Unreleased]" section with anything in it.')
  console.error('A release with no entries is a release nobody can read.')
  process.exit(1)
}
const cut = cutSection(version)

bumpJson(join(root, 'ui', 'package.json'), version)
bumpTauri(join(root, 'src-tauri', 'tauri.conf.json'), version)

console.log(cut
  ? `Cut CHANGELOG [Unreleased] to [${version}], and bumped ui/package.json and src-tauri/tauri.conf.json.`
  : `CHANGELOG already has [${version}]; bumped ui/package.json and src-tauri/tauri.conf.json.`)
console.log('Next:')
console.log(`  git commit -am "release: v${version}"`)
console.log(`  git tag v${version} && git push origin main --tags`)
