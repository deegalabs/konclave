#!/usr/bin/env node
// One source of version truth. Two modes:
//
//   node scripts/release.mjs <version>      Bump ui/package.json + src-tauri/tauri.conf.json to
//                                           <version> and check CHANGELOG.md has a matching section.
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

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// Return the CHANGELOG body under `## [<version>]` (or `## [Unreleased]`), without the heading.
function notes(version) {
  const md = readFileSync(CHANGELOG, 'utf8')
  const lines = md.split('\n')
  const head = (s) => s.startsWith('## ')
  let start = lines.findIndex((l) => head(l) && l.includes(`[${version}]`))
  if (start === -1) start = lines.findIndex((l) => head(l) && l.includes('[Unreleased]'))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (head(lines[i])) { end = i; break }
  return lines.slice(start + 1, end).join('\n').trim()
}

function bumpJson(path, version) {
  const j = JSON.parse(readFileSync(path, 'utf8'))
  j.version = version
  writeFileSync(path, JSON.stringify(j, null, 2) + '\n')
}

// tauri.conf.json is JSON but we only touch the top-level "version" to preserve formatting/comments.
function bumpTauri(path, version) {
  const src = readFileSync(path, 'utf8')
  const out = src.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
  if (out === src) throw new Error(`could not find a top-level "version" in ${path}`)
  writeFileSync(path, out)
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

const section = notes(version)
if (!section) {
  console.error(`CHANGELOG.md has no "## [${version}]" section yet.`)
  console.error('Move the Unreleased entries into a dated section for this version first.')
  process.exit(1)
}

bumpJson(join(root, 'ui', 'package.json'), version)
bumpTauri(join(root, 'src-tauri', 'tauri.conf.json'), version)

console.log(`Bumped ui/package.json and src-tauri/tauri.conf.json to ${version}.`)
console.log('Next:')
console.log(`  git commit -am "release: v${version}"`)
console.log(`  git tag v${version} && git push origin main --tags`)
