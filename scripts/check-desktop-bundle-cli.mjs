// The command the desktop release runs, after `pnpm -C ui run build`, with the env the build had:
//   node scripts/check-desktop-bundle-cli.mjs [distDir]      (distDir defaults to ui/dist)
//
// A file of its own, with no "am I the main module?" test, like check-sw-cli.mjs: comparing
// import.meta.url with argv[1] misses when the path runs through a symlink, or on Windows, and the
// check would then skip itself and exit 0. Here running the file is running the check. The rule is in
// check-desktop-bundle.mjs, with tests (ui/src/desktop-bundle-check.test.ts).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { bundleProblems, REQUIRED } from './check-desktop-bundle.mjs'

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
