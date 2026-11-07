// Which changelog a change is required to touch.
//
// The rule used to live as shell inside `ci.yml`, where it could not be exercised. That gate has
// already shipped one real bug - it diffed from `base.sha` instead of the merge base, and reported
// "CHANGELOG.md updated" for a PR whose only file was `ui/src/theme.ts` - found by red-checking it
// by hand. A rule nobody can run is a rule nobody can check, so it lives here and has tests.
//
// WHY PER PRODUCT. The monorepo ships four things on four different clocks: the web app on every
// merge, the desktop installer on a tag, and the coordinator and relay by hand. A single
// `Unreleased` section cannot say "this has been live on the web for three days and the desktop has
// not cut yet", so each product keeps its own file and cuts when IT ships.
//
// The shared Rust crates deliberately map to the ROOT changelog rather than to a product: a change
// in `orchestrator` or `konclave-seal` can reach the desktop, the coordinator and the browser at
// once, and picking one of them would be a guess. The root file stays the place for anything whose
// blast radius is more than one product.
import { pathToFileURL } from 'node:url'
import { CATEGORIES } from './changelog-sections.mjs'


/** Path prefix -> the changelog that must be touched alongside it. Order matters: first match wins. */
export const OWNERS = [
  ['helper-server/src/', 'helper-server/CHANGELOG.md'],
  ['relay-server/src/', 'relay-server/CHANGELOG.md'],
  // The app itself, which the web and the desktop BOTH ship. One entry, where the change lives.
  ['ui/src/', 'ui/CHANGELOG.md'],
  // The desktop shell. It was in no owner list at all until now, so changing it required no
  // changelog entry of any kind - a gap nobody had noticed because the shell moves rarely.
  ['src-tauri/src/', 'CHANGELOG.md'],
  ['src-tauri/tauri.conf.json', 'CHANGELOG.md'],
  // Shared crates, which can reach the desktop, the coordinator and the browser at once. Naming one
  // product would be a guess, so they stay with the shell in the root file.
  ['orchestrator/src/', 'CHANGELOG.md'],
  ['konclave-signer/src/', 'CHANGELOG.md'],
  ['konclave-wasm/src/', 'CHANGELOG.md'],
  ['konclave-seal/src/', 'CHANGELOG.md'],
]

/** Tests, e2e and CI change no behaviour a member meets; counting them trains everyone to reach
 *  for the `no-changelog` label, which is how an escape hatch becomes the default. */
function memberVisible(path) {
  if (/\.test\.|\/e2e\//.test(path)) return false
  return OWNERS.some(([prefix]) => path.startsWith(prefix))
}

/**
 * The changelogs this set of changed files is required to touch.
 *
 * Returns a sorted, de-duplicated list. Empty means nothing a member meets was touched, so the gate
 * has no opinion - which is a pass, not a silence to be interpreted.
 */
export function requiredChangelogs(changed) {
  const need = new Set()
  for (const p of changed) {
    if (!memberVisible(p)) continue
    const hit = OWNERS.find(([prefix]) => p.startsWith(prefix))
    if (hit) need.add(hit[1])
  }
  return [...need].sort()
}

/** `git diff --name-status` lines are `M\tpath` (renames `R100\told\tnew`); plain paths still work. */
function parse(line) {
  if (!line.includes('\t')) return { status: 'M', path: line }
  const cols = line.split('\t')
  return { status: cols[0][0], path: cols[cols.length - 1] }
}

// Fragments are compiled by scripts/release.mjs for ONLY these two changelogs. A fragment beside the helper's or the
// relay's file would satisfy this gate and never be published, so those keep their file.
const FRAGMENT_OWNERS = ['ui/CHANGELOG.md', 'CHANGELOG.md']

/** A changelog is satisfied by its own file, or by a fragment ADDED or MODIFIED beside it:
 *  `<dir>/changelog.d/<category>/<slug>.md`. Deleting one records nothing. */
function satisfies(file, entries) {
  const dir = file.replace(/CHANGELOG\.md$/, 'changelog.d/')
  const fragmentsCount = FRAGMENT_OWNERS.includes(file)
  return entries.some(({ status, path }) => {
    if (status === 'D') return false
    if (path === file) return true
    if (!fragmentsCount || !path.startsWith(dir) || !path.endsWith('.md')) return false
    const rest = path.slice(dir.length).split('/')
    return rest.length === 2 && CATEGORIES.includes(rest[0])
  })
}

/** What the gate should report: the files still missing, given what the PR touched. */
export function missingChangelogs(changed) {
  const entries = changed.map(parse)
  return requiredChangelogs(entries.map((e) => e.path)).filter((f) => !satisfies(f, entries))
}

// CLI: changed paths on stdin, one per line. Exits non-zero naming what is missing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = await new Promise((r) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { s += c })
    process.stdin.on('end', () => r(s))
  })
  const changed = input.split('\n').map((l) => l.trim()).filter(Boolean)
  const missing = missingChangelogs(changed)
  if (missing.length === 0) {
    const need = requiredChangelogs(changed.map((l) => parse(l).path))
    console.log(need.length ? `Updated: ${need.join(', ')}` : 'No member-visible source touched.')
    process.exit(0)
  }
  console.error('This PR changes something a member meets, and these changelogs were not touched:')
  for (const f of missing) console.error(`  - ${f}`)
  console.error('')
  console.error('Add the entry, or label the PR `no-changelog` if a member genuinely cannot notice it.')
  process.exit(1)
}
