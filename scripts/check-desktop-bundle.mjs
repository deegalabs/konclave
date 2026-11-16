// The desktop release must ship a bundle that knows its coordinator and relay (#664).
//
// The desktop build used to run `pnpm -C ui run build` with neither `VITE_HELPER_BASE` nor
// `VITE_RELAY_BASE` set. Vite inlines `import.meta.env` at build time, so `ui/src/helper.ts` read the
// helper base as '' and the "Konclave-hosted" option never appeared; the relay base fell back to the
// app's own origin, where no relay answers. Nothing failed: the installers built, attached and
// shipped. This check is what makes that build fail instead.
//
// It asks three things of the build:
//   1. both variables are set, non-empty, and https origins (nothing after the host);
//   2. the built JavaScript in `ui/dist/assets` carries each value as Vite inlines a static read
//      (`import.meta.env.VITE_HELPER_BASE`): a whole string literal, exactly that value, in any quote
//      Vite picks. The URL in a comment, inside a longer string, or as the start of a longer host
//      does not count. A variable set on the wrong step, or a build that ignored it, passes 1 and
//      fails 2;
//   3. no env key NAME survives in the built JavaScript (#605). A key name in the bundle means a
//      whole env object was inlined, which carries every VITE_* variable the build saw, including
//      the ones the host adds on its own (Vercel injects one), so the bytes stop being reproducible
//      from the repository and no published manifest can match them. The web build (ci.yml) runs
//      this third rule alone, with `--web`: it has no addresses to require.
// Until #605 the rule was the opposite (the key next to its value), because the app read the env
// as an object; both halves live here so the two cannot drift apart again.
//
// The rule only; the workflow runs `scripts/check-desktop-bundle-cli.mjs`, which has no "am I the
// main module?" test to get wrong (see check-sw-cli.mjs for why that matters on Windows).

import { createRequire } from 'node:module'
import { ENV_NAME } from './web-manifest.mjs'

/** The variables the desktop bundle must carry, in the order they are reported. */
export const REQUIRED = ['VITE_HELPER_BASE', 'VITE_RELAY_BASE']

/** Why `value` is not a usable base for `name`, or null when it is. */
export function invalidBase(name, value) {
  if (value === undefined || value.trim() === '') return `${name} is empty: the desktop app would build without it`
  let u
  try { u = new URL(value) } catch { return `${name} is not a URL: ${JSON.stringify(value)}` }
  if (u.protocol !== 'https:') return `${name} must be https: ${value}`
  if (value !== u.origin) return `${name} must be an origin with nothing after the host (as the coordinator matches it): ${value}`
  return null
}

// Both rules read the JavaScript's syntax, not its text. A text match was fooled by the bundle's own
// prose: the release pages carry the changelog, whose #664 entry quotes both addresses in markdown
// backticks inside one long string, which a pattern took for the inlined value (#605 review). Here a
// value counts only as a whole string literal, and a key name only as an object key. TypeScript's
// parser is the one the source scans use (ui/src/source-scan.ts); it is resolved from ui/, where the
// workspace installs it.
const ts = createRequire(new URL('../ui/package.json', import.meta.url))('typescript')
const scans = new Map()

/** The string literals and the object keys in `source`, each as a set of their values. */
function scan(source) {
  const hit = scans.get(source)
  if (hit) return hit
  const literals = new Set()
  const keys = new Set()
  const sf = ts.createSourceFile('bundle.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.add(node.text)
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) keys.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const out = { literals, keys }
  scans.set(source, out)
  return out
}

/** True when `source` carries `value` as one whole string literal, nothing else inside. */
export function carries(source, value) {
  return scan(source).literals.has(value)
}

/** The env key names (`VITE_` and anything after it) used as object keys in `source`, sorted. A name
 *  in a string, a comment or a longer identifier (`INVITE_LENGTH`) is not one. */
export function envKeysIn(source) {
  return [...scan(source).keys].filter((k) => ENV_NAME.test(k)).sort()
}

/** Every problem with this env and these built sources; an empty list means the bundle is good.
 *  `web: true` checks rule 3 alone. */
export function bundleProblems(env, sources, { web = false } = {}) {
  const problems = []
  if (!web) {
    for (const name of REQUIRED) {
      const value = env[name]
      const bad = invalidBase(name, value)
      if (bad) { problems.push(bad); continue }
      if (!sources.some((s) => carries(s, value))) problems.push(`${name}=${value} is set but not in the built bundle`)
    }
  }
  const keys = new Set(sources.flatMap(envKeysIn))
  for (const k of [...keys].sort()) {
    problems.push(`the bundle carries the env key ${k}: an env object was inlined, so its bytes depend on whatever variables the host sets (read import.meta.env.VITE_<NAME> directly)`)
  }
  return problems
}
