// web-verify.mjs - the rules of `scripts/verify-web.mjs` (#605), with `fetch` handed in so the tests
// can serve a site of their own. Reads the format only through web-manifest.mjs and compares commits
// only through what-is-running.mjs.
//
// What a PASS means, and what it does not (CLAUDE.md principle 14):
//   - every file the release's manifest lists was fetched from the site, now, from this network,
//     and had the listed SHA-256; `/` was the listed index.html; the headers the release configures
//     were the ones sent on `/`;
//   - it does NOT prove what another member got: a server can answer differently to different
//     people, or change after this run;
//   - it cannot see a file nothing references, which a manifest cannot list (a host can serve more
//     than the build: www.konclave.xyz answers on /_vercel/ paths of its own);
//   - it trusts the manifest it is given (by default the one attached to the GitHub release; check
//     it with the attestation, or by rebuilding, docs/VERIFY-WEB.md);
//   - without --expect-version, an older published release passes too;
//   - it checks the site, not the copy a member's browser or installed app is already running;
//   - it does NOT stop a compromised server, and it does not check the desktop app (#606).

import { parseManifest, fingerprint, sha256Hex, isVersion, shortCommit, MANIFEST_FILE } from './web-manifest.mjs'
import { commitMismatch, WEB_ORIGIN } from './what-is-running.mjs'

export const REPO = 'deegalabs/konclave'
export const MAX_FILE_BYTES = 16 * 1024 * 1024
const TIMEOUT_MS = 20_000
const LIMITS = 'This is what this fetch received, from this network, now. It cannot see files nothing references, does not prove what another member received, and does not stop a compromised server. On the web, Konclave only lives at www.konclave.xyz: check the address bar too.'

/** Exit codes, as verify-proof.mjs: a mismatch and "could not check" are different answers. */
export const EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2, USAGE: 3 }

/** The release asset URL of a version's manifest. Built from fixed parts and a validated version,
 *  never from a string the site supplied as is. */
export function manifestUrl(version) {
  if (!isVersion(version)) throw new Error(`not a release version: ${JSON.stringify(version)}`)
  return `https://github.com/${REPO}/releases/download/v${version}/${MANIFEST_FILE}`
}

/** Why `site` is not an origin this script checks, or null. https only; plain http only on the
 *  loopback, for tests and a local build. */
export function badSite(site) {
  let u
  try { u = new URL(site) } catch { return `not a URL: ${site}` }
  if (u.origin !== site) return `give an origin with nothing after the host: ${u.origin}`
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null
  return `https only: ${site}`
}

class Inconclusive extends Error {}

/** A manifest from an https URL, with the same time and size limits as every other fetch here.
 *  Returns { bytes } or { code, line } when there is no manifest to read. */
export async function fetchManifest(url, fetchFn = fetch) {
  if (!/^https:\/\//.test(url)) return { code: EXIT.USAGE, line: `USAGE --manifest must be a file or an https URL: ${url}` }
  try {
    const r = await get(fetchFn, url, { follow: true })
    if (r.tooBig) return { code: EXIT.USAGE, line: `USAGE ${url} is larger than ${MAX_FILE_BYTES} bytes` }
    if (r.status !== 200) return { code: EXIT.INCONCLUSIVE, line: `INCONCLUSIVE ${url} answered HTTP ${r.status}` }
    return { bytes: r.bytes }
  } catch (e) {
    if (e instanceof Inconclusive) return { code: EXIT.INCONCLUSIVE, line: `INCONCLUSIVE ${e.message}` }
    throw e
  }
}

/** One GET with no redirects followed, a time limit and a size cap. Returns { status, headers,
 *  bytes } or throws Inconclusive when the network gave no answer. */
async function get(fetchFn, url, { follow = false } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetchFn(url, { redirect: follow ? 'follow' : 'manual', cache: 'no-store', signal: ctl.signal })
    const tooBig = () => { ctl.abort(); return { status: res.status, headers: res.headers, bytes: null, tooBig: true } }
    if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) return tooBig()
    // Read in chunks and stop at the cap: a body with no length (chunked) is never held whole.
    const chunks = []
    let total = 0
    if (res.body) {
      const reader = res.body.getReader()
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        total += r.value.length
        if (total > MAX_FILE_BYTES) { await reader.cancel().catch(() => {}); return tooBig() }
        chunks.push(r.value)
      }
    }
    const bytes = new Uint8Array(total)
    let at = 0
    for (const c of chunks) { bytes.set(c, at); at += c.length }
    return { status: res.status, headers: res.headers, bytes }
  } catch (e) {
    throw new Inconclusive(`${url}: ${e?.name === 'AbortError' ? 'timed out' : (e?.message ?? e)}`)
  } finally {
    clearTimeout(timer)
  }
}

const text = (bytes) => new TextDecoder().decode(bytes)

/**
 * Checks `site` against a release manifest. `manifest` is { bytes, from } when the caller already has
 * it, or omitted to fetch the release asset of the version the site claims. Returns { code, lines }.
 */
export async function verifyWeb({ site = WEB_ORIGIN, manifest, expectVersion, fetchFn = fetch }) {
  const lines = []
  // Whatever the site sent is shown escaped: a control character in a commit or a header must not
  // rewrite the terminal line a reader takes for the verdict.
  const esc = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  const out = (s) => lines.push(esc(s))
  // Every run ends with what the answer does not cover, whatever the answer was.
  const done = (code) => {
    if (code === EXIT.FAIL) out('On a FAIL: do not unlock a vault with this app, tell the other members of your vault, and report it (SECURITY.md).')
    out(LIMITS)
    return { code, lines }
  }
  const why = badSite(site)
  if (why) { out(`USAGE ${why}`); return done(EXIT.USAGE) }
  if (expectVersion !== undefined && !isVersion(expectVersion)) { out(`USAGE --expect-version ${expectVersion} is not a release version`); return done(EXIT.USAGE) }

  try {
    const vr = await get(fetchFn, `${site}/version.json`)
    if (vr.status >= 500) { out(`INCONCLUSIVE version.json (HTTP ${vr.status})`); return done(EXIT.INCONCLUSIVE) }
    if (vr.status !== 200 || !vr.bytes) { out(`FAIL version.json (HTTP ${vr.status})`); return done(EXIT.FAIL) }
    let claimed
    try { claimed = JSON.parse(text(vr.bytes)) } catch { out('FAIL version.json is not JSON'); return done(EXIT.FAIL) }
    if (!isVersion(claimed?.version)) { out(`FAIL version.json names no release version: ${JSON.stringify(claimed?.version)}`); return done(EXIT.FAIL) }
    out(`site ${site} says version ${claimed.version}, commit ${claimed.commit}`)
    if (expectVersion !== undefined && claimed.version !== expectVersion) {
      out(`FAIL the site serves ${claimed.version}, expected ${expectVersion}`)
      return done(EXIT.FAIL)
    }

    let mBytes = manifest?.bytes
    let from = manifest?.from
    if (mBytes === undefined) {
      from = manifestUrl(claimed.version)
      const mr = await get(fetchFn, from, { follow: true })
      if (mr.status === 404) {
        out(`INCONCLUSIVE no published manifest for v${claimed.version} at ${from} (a release from before manifests, 0.21.0 or earlier; not released yet; or the release is still a draft)`)
        return done(EXIT.INCONCLUSIVE)
      }
      if (mr.status !== 200 || !mr.bytes) { out(`INCONCLUSIVE ${from} answered HTTP ${mr.status}`); return done(EXIT.INCONCLUSIVE) }
      mBytes = mr.bytes
    }
    let m
    try { m = parseManifest(mBytes) } catch (e) { out(`USAGE ${e.message} (${from})`); return done(EXIT.USAGE) }
    out(`manifest ${from}: v${m.version}, commit ${shortCommit(m.commit)}, ${m.files.length} files, SHA-256 ${await fingerprint(mBytes)}`)

    if (claimed.version !== m.version) {
      out(`FAIL the site says ${claimed.version}, the manifest is of ${m.version}`)
      return done(EXIT.FAIL)
    }
    const cm = commitMismatch(claimed.commit, m.commit)
    if (cm !== null) {
      out(`NOT A RELEASE the site's commit is ${cm}, not release v${m.version}'s. main moves only by a release merge or a tagged hotfix (docs/RELEASING.md), so this is a deploy outside that rule (main ahead of the latest tag) or a build that is not ours; either way, not a published release`)
      return done(EXIT.FAIL)
    }

    let failed = 0
    let unknown = 0
    let headerFailed = 0
    const check = async (label, path, expected, emit = out) => {
      try {
        const r = await get(fetchFn, `${site}/${path}`)
        if (r.tooBig) { failed++; emit(`FAIL ${label} (larger than ${MAX_FILE_BYTES} bytes)`); return null }
        // A server error says nothing about the bytes: inconclusive, not a mismatch.
        if (r.status >= 500) { unknown++; emit(`INCONCLUSIVE ${label} (HTTP ${r.status})`); return null }
        if (r.status !== 200) { failed++; emit(`FAIL ${label} (HTTP ${r.status})`); return null }
        const got = await sha256Hex(r.bytes)
        if (got !== expected.sha256) { failed++; emit(`FAIL ${label} (expected ${expected.sha256}, got ${got})`); return null }
        emit(`PASS ${label}`)
        return r
      } catch (e) {
        if (!(e instanceof Inconclusive)) throw e
        unknown++; emit(`INCONCLUSIVE ${label}: ${e.message}`); return null
      }
    }
    // Eight at a time, reported in the manifest's order so two runs read the same.
    const results = new Array(m.files.length)
    let next = 0
    const workers = Array.from({ length: 8 }, async () => {
      for (let i = next++; i < m.files.length; i = next++) {
        const mine = []
        await check(m.files[i].path, m.files[i].path, m.files[i], (line) => mine.push(esc(line)))
        results[i] = mine
      }
    })
    await Promise.all(workers)
    for (const r of results) lines.push(...r)

    let headersChecked = false
    const index = m.files.find((f) => f.path === 'index.html')
    if (!index) { failed++; out('FAIL the manifest lists no index.html') }
    else {
      const root = await check('/ (index.html)', '', index)
      if (root) {
        headersChecked = true
        for (const { name, value } of m.headers) {
          const got = root.headers.get(name)
          if (got === value) out(`PASS header ${name}`)
          else { headerFailed++; out(`FAIL header ${name} (expected ${JSON.stringify(value)}, got ${got === null ? 'none' : JSON.stringify(got)})`) }
        }
      }
    }

    out(`${failed || headerFailed ? 'FAIL' : unknown ? 'INCONCLUSIVE' : 'PASS'}: ${m.files.length + 1 - failed - unknown} of ${m.files.length + 1} files matched (/ included), ${failed} failed, ${unknown} could not be fetched; ${headersChecked ? `${m.headers.length - headerFailed} of ${m.headers.length} headers matched` : 'headers not checked (/ did not pass)'}.`)
    failed += headerFailed
    return done(failed ? EXIT.FAIL : unknown ? EXIT.INCONCLUSIVE : EXIT.PASS)
  } catch (e) {
    if (e instanceof Inconclusive) { out(`INCONCLUSIVE ${e.message}`); return done(EXIT.INCONCLUSIVE) }
    throw e
  }
}
