// web-dist.mjs - what the release's writer reads from disk to make a web manifest (#605).
// Node only; the format itself is web-manifest.mjs, which runs in a browser too. Tests:
// ui/src/web-manifest.test.ts.
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { ENV_NAME, shortCommit } from './web-manifest.mjs'

/** Every regular file under `dir` as { path, bytes }, paths relative and `/`-separated, sorted.
 *  A symlink or any other kind of entry stops the writer: the host serves bytes, and a link's
 *  target is not something the manifest can vouch for. */
export function listDist(dir) {
  const out = []
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      const st = lstatSync(join(dir, r))
      if (st.isSymbolicLink()) throw new Error(`web dist: ${r} is a symlink`)
      if (st.isDirectory()) walk(r)
      else if (st.isFile()) out.push({ path: r, bytes: new Uint8Array(readFileSync(join(dir, r))) })
      else throw new Error(`web dist: ${r} is not a regular file`)
    }
  }
  walk('')
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The headers ui/vercel.json sets on every path (`source: "/(.*)"`), as { name: value }. Read from
 *  the file the host is configured by, never restated, so the manifest says what the host is told. */
export function headersFromVercelJson(text) {
  const cfg = JSON.parse(text)
  const rules = (cfg.headers ?? []).filter((r) => r.source === '/(.*)')
  if (rules.length !== 1) throw new Error(`ui/vercel.json: expected one header rule for "/(.*)", found ${rules.length}`)
  return Object.fromEntries(rules[0].headers.map(({ key, value }) => [key, value]))
}

/** The VITE_* variables in `env`: the build inputs that change the bundle's bytes. */
export function buildEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => ENV_NAME.test(k) && v !== undefined))
}

/** Why the build in `files` is not the build of `version` at `commit`, or null. The build names
 *  itself in `version.json` (ui/vite.config.ts writes it, with the commit cut to 7 characters); a
 *  manifest that claims another commit or version would vouch for bytes it did not describe. */
export function identityMismatch(files, version, commit) {
  const f = files.find((x) => x.path === 'version.json')
  if (!f) return 'the build has no version.json'
  let v
  try { v = JSON.parse(new TextDecoder().decode(f.bytes)) } catch { return 'version.json is not JSON' }
  if (v.version !== version) return `the build says version ${v.version}, ui/package.json says ${version}`
  if (v.commit !== shortCommit(commit)) return `the build says commit ${v.commit}, the manifest would say ${shortCommit(commit)}`
  return null
}
