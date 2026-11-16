// web-manifest.mjs - the ONE home of the web release manifest's format (#605).
//
// A release publishes `web-manifest.json`: the SHA-256 and size of every file the web build serves,
// the commit and version it was built from, the build variables that change its bytes, and the
// security headers the host is configured to send. Anyone can then fetch the live site and compare
// (scripts/verify-web.mjs), or rebuild the commit and compare, without trusting us or the host.
//
// Everything that writes or reads a manifest goes through this file: the release's writer
// (web-manifest-cli.mjs), the verifier, and later the in-app check (#605 steps 3-5) and the copy
// published on Arweave. That is why it has no `node:` import and hashes with WebCrypto: the same
// module has to run in a browser. It reads nothing from disk; the caller hands it the bytes.
//
// One manifest, one fingerprint: the text is written by `serializeManifest` and nothing else, and
// `parseManifest` refuses any text that is not exactly what `serializeManifest` would write for the
// object it holds (other whitespace, other key order, unknown keys). The fingerprint is the SHA-256
// of the published bytes.
//
// What the format does NOT carry: the toolchain (Node major, pnpm, the lockfile) is also an input to
// the bytes; the commit pins the lockfile, the rest is the CI's. The manifest never lists itself.

export const FORMAT = 'konclave-web-manifest'
export const FORMAT_VERSION = 1
/** The name of the release asset, and the one file a manifest may never list. */
export const MANIFEST_FILE = 'web-manifest.json'

// A release version: numbers without leading zeros, an optional pre-release tag.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const SEGMENT = /^[A-Za-z0-9._-]+$/
/** An env variable Vite inlines: the one rule for its name, used by the manifest, the writer and
 *  the bundle check (scripts/check-desktop-bundle.mjs). */
export const ENV_NAME = /^VITE_\w+$/
const HEADER_NAME = /^[A-Za-z0-9-]+$/

/** The commit as the build names itself in version.json and the footer (ui/vite.config.ts). */
export const shortCommit = (commit) => String(commit).slice(0, 7)

/** True when `v` is a release version (no `v` prefix). */
export const isVersion = (v) => typeof v === 'string' && SEMVER.test(v)

/** Why `path` cannot be a served path in a manifest, or null. Relative, `/`-separated, each segment
 *  from a closed set of characters and never `.` or `..`: nothing a URL could resolve elsewhere. */
export function badPath(path) {
  if (typeof path !== 'string' || path === '') return 'empty path'
  const segs = path.split('/')
  for (const s of segs) {
    if (!SEGMENT.test(s) || s === '.' || s === '..') return `path ${JSON.stringify(path)} is not a plain relative path`
  }
  if (path === MANIFEST_FILE) return `a manifest never lists ${MANIFEST_FILE}`
  return null
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function fail(msg) { throw new Error(`web manifest: ${msg}`) }

/**
 * The manifest object, validated, with its lists in their one order.
 * `env` and `headers` are plain { name: value } records; `files` is [{ path, sha256, size }].
 */
export function buildManifest({ version, commit, env, headers, files }) {
  if (!isVersion(version)) fail(`version ${JSON.stringify(version)} is not a release version`)
  if (typeof commit !== 'string' || !COMMIT.test(commit)) fail(`commit ${JSON.stringify(commit)} is not a 40-hex commit`)
  const pairs = (rec, re, what) => {
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) fail(`${what} must be a record`)
    const lower = new Set()
    return Object.keys(rec).sort(byCodeUnit).map((name) => {
      if (!re.test(name)) fail(`${what} name ${JSON.stringify(name)} is not allowed`)
      if (lower.has(name.toLowerCase())) fail(`${what} name ${name} listed twice`)
      lower.add(name.toLowerCase())
      if (typeof rec[name] !== 'string') fail(`${what} ${name} must be a string`)
      return { name, value: rec[name] }
    })
  }
  if (!Array.isArray(files) || files.length === 0) fail('no files')
  const seen = new Set()
  const list = files.map((f) => {
    const why = badPath(f?.path)
    if (why) fail(why)
    if (seen.has(f.path)) fail(`path ${f.path} listed twice`)
    seen.add(f.path)
    if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) fail(`sha256 of ${f.path} is not 64 lowercase hex`)
    if (!Number.isSafeInteger(f.size) || f.size < 0) fail(`size of ${f.path} is not a non-negative integer`)
    return { path: f.path, sha256: f.sha256, size: f.size }
  }).sort((a, b) => byCodeUnit(a.path, b.path))
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    version,
    commit,
    build: { env: pairs(env, ENV_NAME, 'build env') },
    headers: pairs(headers, HEADER_NAME, 'header'),
    files: list,
  }
}

/** The one text of a manifest object. The object is rebuilt first, so key order is always this. */
export function serializeManifest(m) {
  const toRec = (list) => Object.fromEntries((list ?? []).map(({ name, value }) => [name, value]))
  const b = buildManifest({ version: m.version, commit: m.commit, env: toRec(m.build?.env), headers: toRec(m.headers), files: m.files })
  return JSON.stringify(b, null, 2) + '\n'
}

const KEYS = {
  top: ['format', 'formatVersion', 'version', 'commit', 'build', 'headers', 'files'],
  build: ['env'],
  pair: ['name', 'value'],
  file: ['path', 'sha256', 'size'],
}
const exactKeys = (o, keys, what) => {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) fail(`${what} is not an object`)
  const got = Object.keys(o)
  if (got.length !== keys.length || got.some((k, i) => k !== keys[i])) fail(`${what} has keys ${JSON.stringify(got)}, expected ${JSON.stringify(keys)}`)
}

/** Bytes as the strict UTF-8 text they must be: invalid UTF-8 or a byte-order mark is refused, so
 *  one manifest's bytes, its text and its fingerprint stay one thing. */
function textOf(input) {
  if (typeof input === 'string') return input
  if (!(input instanceof Uint8Array)) fail('not text or bytes')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input) } catch { fail('not valid UTF-8') }
}

/** The manifest held by `input` (the published bytes, or their text), or an Error naming what is
 *  wrong. Strict: format v1 exactly, in its canonical text. A newer format is refused by name, so an
 *  old reader never half-reads it. Pass the bytes when you have them. */
export function parseManifest(input) {
  const text = textOf(input)
  let o
  try { o = JSON.parse(text) } catch { fail('not JSON') }
  if (o?.format !== FORMAT) fail(`format ${JSON.stringify(o?.format)} is not ${FORMAT}`)
  if (o.formatVersion !== FORMAT_VERSION) fail(`formatVersion ${JSON.stringify(o.formatVersion)} is not supported (this reader knows ${FORMAT_VERSION})`)
  exactKeys(o, KEYS.top, 'the manifest')
  exactKeys(o.build, KEYS.build, 'build')
  for (const [list, keys, what] of [[o.build.env, KEYS.pair, 'build env entry'], [o.headers, KEYS.pair, 'header entry'], [o.files, KEYS.file, 'file entry']]) {
    if (!Array.isArray(list)) fail(`${what} list is not an array`)
    for (const e of list) exactKeys(e, keys, what)
  }
  for (const [list, what] of [[o.build.env, 'build env'], [o.headers, 'header']]) {
    const names = list.map((e) => e.name)
    if (new Set(names).size !== names.length) fail(`${what} name listed twice`)
  }
  if (serializeManifest(o) !== text) fail('not in canonical form (written by something other than serializeManifest)')
  return o
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** SHA-256 hex of bytes (Uint8Array) or of a string's UTF-8 bytes. */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes))
}

/** The fingerprint of a published manifest: the SHA-256 of its bytes (a string is taken as its
 *  UTF-8 bytes, which is what serializeManifest writes). */
export const fingerprint = (bytesOrText) => sha256Hex(bytesOrText)

/** [{ path, bytes }] -> [{ path, sha256, size }]. */
export async function hashFiles(files) {
  return Promise.all(files.map(async ({ path, bytes }) => ({ path, sha256: await sha256Hex(bytes), size: bytes.length })))
}

/** The line a release's notes carry about the web app. It names the file and its fingerprint; it
 *  claims nothing about what is deployed. */
export function notesLine(m, fp) {
  if (!SHA256.test(fp)) fail('fingerprint is not 64 lowercase hex')
  return `Web app v${m.version} (commit ${shortCommit(m.commit)}): ${MANIFEST_FILE} lists the SHA-256 of all ${m.files.length} files of this build; the manifest's own SHA-256 is ${fp}.`
}
