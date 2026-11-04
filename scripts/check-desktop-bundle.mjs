// The desktop release must ship a bundle that knows its coordinator and relay (#664).
//
// The desktop build used to run `pnpm -C ui run build` with neither `VITE_HELPER_BASE` nor
// `VITE_RELAY_BASE` set. Vite inlines `import.meta.env` at build time, so `ui/src/helper.ts` read the
// helper base as '' and the "Konclave-hosted" option never appeared; the relay base fell back to the
// app's own origin, where no relay answers. Nothing failed: the installers built, attached and
// shipped. This check is what makes that build fail instead.
//
// It asks two things of the build, and both are needed:
//   1. both variables are set, non-empty, and https origins (nothing after the host);
//   2. each value is actually present in the built JavaScript in `ui/dist/assets`. A variable set on
//      the wrong step, or a build that ignored it, passes 1 and fails 2.
//
// Usage (from the repo root, after `pnpm -C ui run build`, with the same env the build had):
//   node scripts/check-desktop-bundle.mjs [distDir]
// Exit 0 when the bundle carries both; 1 with a reason otherwise. The rule is exported for the tests.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** Every problem with this env and these built sources; an empty list means the bundle is good. */
export function bundleProblems(env, sources) {
  const problems = []
  for (const name of REQUIRED) {
    const value = env[name]
    const bad = invalidBase(name, value)
    if (bad) { problems.push(bad); continue }
    if (!sources.some((s) => s.includes(value))) problems.push(`${name}=${value} is set but not in the built bundle`)
  }
  return problems
}

function main() {
  const dist = process.argv[2] ?? join('ui', 'dist')
  const assets = join(dist, 'assets')
  if (!existsSync(assets)) {
    console.error(`no built bundle at ${assets}: run \`pnpm -C ui run build\` first`)
    process.exit(1)
  }
  const sources = readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8'))
  const problems = bundleProblems(process.env, sources)
  if (problems.length) {
    for (const p of problems) console.error(`desktop bundle: ${p}`)
    process.exit(1)
  }
  for (const name of REQUIRED) console.log(`desktop bundle: ${name}=${process.env[name]}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
