// The command the desktop release runs, after `pnpm -C ui run build`, with the env the build had:
//   node scripts/check-desktop-bundle-cli.mjs [distDir]        (distDir defaults to ui/dist)
// and ci.yml, after the web build, checks only that no env key name was inlined (#605):
//   node scripts/check-desktop-bundle-cli.mjs --web [distDir]
//
// A file of its own, with no "am I the main module?" test, like check-sw-cli.mjs: comparing
// import.meta.url with argv[1] misses when the path runs through a symlink, or on Windows, and the
// check would then skip itself and exit 0. Here running the file is running the check. The rule is in
// check-desktop-bundle.mjs, with tests (ui/src/desktop-bundle-check.test.ts).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { bundleProblems, REQUIRED } from './check-desktop-bundle.mjs'

const args = process.argv.slice(2)
const web = args[0] === '--web'
const dist = (web ? args[1] : args[0]) ?? join('ui', 'dist')
const label = web ? 'web bundle' : 'desktop bundle'
const assets = join(dist, 'assets')
if (!existsSync(assets)) {
  console.error(`no built bundle at ${assets}: run \`pnpm -C ui run build\` first`)
  process.exit(1)
}
const sources = readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8'))
const problems = bundleProblems(process.env, sources, { web })
if (problems.length) {
  for (const p of problems) console.error(`${label}: ${p}`)
  process.exit(1)
}
if (web) console.log(`${label}: no env key name inlined`)
else for (const name of REQUIRED) console.log(`${label}: ${name}=${process.env[name]}`)
