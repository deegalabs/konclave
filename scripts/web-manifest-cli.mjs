// The command the release runs after building the web app (#605):
//   node scripts/web-manifest-cli.mjs write <distDir> <commit> <out.json>
//     writes the manifest of <distDir> and prints its fingerprint on stdout;
//   node scripts/web-manifest-cli.mjs notes <manifest.json>
//     prints the release-notes line for it.
// The version comes from ui/package.json, the build env from this process's VITE_* variables (run it
// with the env the build had), the headers from ui/vercel.json. A file of its own with no "am I the
// main module?" test (see check-sw-cli.mjs). The format: web-manifest.mjs; disk reads: web-dist.mjs.
import { readFileSync, writeFileSync } from 'node:fs'
import { buildManifest, serializeManifest, parseManifest, fingerprint, hashFiles, notesLine } from './web-manifest.mjs'
import { listDist, headersFromVercelJson, buildEnv, identityMismatch } from './web-dist.mjs'

const root = new URL('../', import.meta.url)
const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'write' && args.length === 3) {
  const [dist, commit, out] = args
  const { version } = JSON.parse(readFileSync(new URL('ui/package.json', root), 'utf8'))
  const headers = headersFromVercelJson(readFileSync(new URL('ui/vercel.json', root), 'utf8'))
  const files = listDist(dist)
  const why = identityMismatch(files, version, commit)
  if (why) { console.error(`web manifest: ${why}`); process.exit(1) }
  const m = buildManifest({ version, commit, env: buildEnv(process.env), headers, files: await hashFiles(files) })
  const text = serializeManifest(m)
  writeFileSync(out, text)
  console.log(await fingerprint(text))
} else if (cmd === 'notes' && args.length === 1) {
  const bytes = new Uint8Array(readFileSync(args[0]))
  console.log(notesLine(parseManifest(bytes), await fingerprint(bytes)))
} else {
  console.error('usage: web-manifest-cli.mjs write <distDir> <commit> <out.json> | notes <manifest.json>')
  process.exit(3)
}
