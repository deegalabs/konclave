import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
// @ts-expect-error - plain .mjs scripts, deliberately not part of the app's TS build
import { buildManifest, serializeManifest, parseManifest, fingerprint, hashFiles, notesLine, badPath, isVersion, MANIFEST_FILE } from '../../scripts/web-manifest.mjs'
// @ts-expect-error - plain .mjs script
import { listDist, headersFromVercelJson, buildEnv, identityMismatch } from '../../scripts/web-dist.mjs'

// #605: the web release manifest. One format, one canonical text, one fingerprint.
const C = 'a'.repeat(40)
const H = (s: string) => createHash('sha256').update(s).digest('hex')
const base = {
  version: '0.22.0',
  commit: C,
  env: { VITE_RELAY_BASE: 'https://relay.konclave.xyz', VITE_HELPER_BASE: 'https://helper.konclave.xyz' },
  headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'" },
  files: [
    { path: 'index.html', sha256: H('i'), size: 1 },
    { path: 'assets/a-XXXXXXXX.js', sha256: H('a'), size: 2 },
  ],
}

describe('the web manifest format (#605)', () => {
  it('writes one canonical text, with every list in code-unit order', () => {
    const text = serializeManifest(buildManifest(base))
    const o = JSON.parse(text)
    expect(Object.keys(o)).toEqual(['format', 'formatVersion', 'version', 'commit', 'build', 'headers', 'files'])
    expect(o.files.map((f: { path: string }) => f.path)).toEqual(['assets/a-XXXXXXXX.js', 'index.html'])
    expect(o.build.env.map((e: { name: string }) => e.name)).toEqual(['VITE_HELPER_BASE', 'VITE_RELAY_BASE'])
    // Uppercase sorts before lowercase by code unit; localeCompare would not.
    expect(o.headers.map((e: { name: string }) => e.name)).toEqual(['Content-Security-Policy', 'X-Frame-Options'])
    expect(text.endsWith('}\n')).toBe(true)
    // The same input in another order writes the same bytes.
    const shuffled = { ...base, files: [...base.files].reverse(), env: { VITE_HELPER_BASE: base.env.VITE_HELPER_BASE, VITE_RELAY_BASE: base.env.VITE_RELAY_BASE } }
    expect(serializeManifest(buildManifest(shuffled))).toBe(text)
  })

  it('reads back exactly what it wrote, and nothing else', () => {
    const text = serializeManifest(buildManifest(base))
    expect(serializeManifest(parseManifest(text))).toBe(text)
    // Same JSON, other whitespace: a second text for one manifest would be a second fingerprint.
    expect(() => parseManifest(JSON.stringify(JSON.parse(text)))).toThrow(/canonical/)
    expect(() => parseManifest(text.replace(/\n$/, ''))).toThrow(/canonical/)
  })

  it('refuses unknown keys, a newer format, and broken values', () => {
    const o = JSON.parse(serializeManifest(buildManifest(base)))
    const t = (x: unknown) => JSON.stringify(x, null, 2) + '\n'
    expect(() => parseManifest(t({ ...o, extra: 1 }))).toThrow(/keys/)
    expect(() => parseManifest(t({ ...o, formatVersion: 2 }))).toThrow(/formatVersion 2 is not supported/)
    expect(() => parseManifest(t({ ...o, format: 'other' }))).toThrow(/format/)
    expect(() => parseManifest(t({ ...o, files: [{ ...o.files[0], mode: 1 }] }))).toThrow(/keys/)
    expect(() => parseManifest(t({ ...o, files: [{ ...o.files[0], sha256: 'A'.repeat(64) }] }))).toThrow(/sha256/)
    expect(() => parseManifest(t({ ...o, files: [o.files[0], o.files[0]] }))).toThrow(/twice/)
    expect(() => parseManifest(t({ ...o, headers: [o.headers[0], o.headers[0]] }))).toThrow(/twice/)
    expect(() => parseManifest(t({ ...o, version: '0.21.0/../../x' }))).toThrow(/version/)
    expect(() => parseManifest('not json')).toThrow(/not JSON/)
  })

  it('validates what it builds', () => {
    expect(() => buildManifest({ ...base, version: 'v0.22.0' })).toThrow(/version/)
    expect(() => buildManifest({ ...base, commit: 'abc1234' })).toThrow(/commit/)
    expect(() => buildManifest({ ...base, files: [] })).toThrow(/no files/)
    expect(() => buildManifest({ ...base, files: [{ path: 'a', sha256: H('a'), size: -1 }] })).toThrow(/size/)
    expect(() => buildManifest({ ...base, env: { NODE_ENV: 'x' } })).toThrow(/build env name/)
    expect(() => buildManifest({ ...base, headers: { 'Bad Header': 'x' } })).toThrow(/header name/)
  })

  it('takes only plain relative paths, and never lists itself', () => {
    for (const ok of ['index.html', 'assets/a-b_c.js', 'videos/.gitkeep']) expect(badPath(ok)).toBeNull()
    for (const bad of ['', '/index.html', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'a?x', 'a#x', 'a b', 'é', MANIFEST_FILE]) {
      expect(badPath(bad), bad).not.toBeNull()
    }
  })

  it('accepts release versions only', () => {
    expect(isVersion('0.21.0')).toBe(true)
    expect(isVersion('1.0.0-rc.1')).toBe(true)
    for (const v of ['v0.21.0', '0.21', '0.21.0/x', '01.2.3', '0.021.0', '', null]) expect(isVersion(v), String(v)).toBe(false)
  })

  it('keeps format v1 byte for byte: a manifest already published must still read, with its fingerprint', async () => {
    // The literal text of a v1 manifest. If this test fails, the writer changed format v1 and every
    // published manifest would be refused or fingerprinted differently: that is formatVersion 2.
    const GOLDEN = [
      '{', '  "format": "konclave-web-manifest",', '  "formatVersion": 1,', '  "version": "0.22.0",',
      `  "commit": "${C}",`, '  "build": {', '    "env": [', '      {', '        "name": "VITE_HELPER_BASE",',
      '        "value": "https://helper.konclave.xyz"', '      },', '      {', '        "name": "VITE_RELAY_BASE",',
      '        "value": "https://relay.konclave.xyz"', '      }', '    ]', '  },', '  "headers": [', '    {',
      '      "name": "Content-Security-Policy",', `      "value": "default-src 'self'"`, '    },', '    {',
      '      "name": "X-Frame-Options",', '      "value": "DENY"', '    }', '  ],', '  "files": [', '    {',
      '      "path": "assets/a-XXXXXXXX.js",', `      "sha256": "${H('a')}",`, '      "size": 2', '    },', '    {',
      '      "path": "index.html",', `      "sha256": "${H('i')}",`, '      "size": 1', '    }', '  ]', '}', '',
    ].join('\n')
    expect(serializeManifest(buildManifest(base))).toBe(GOLDEN)
    expect(parseManifest(GOLDEN).version).toBe('0.22.0')
    expect(await fingerprint(GOLDEN)).toBe(H(GOLDEN))
  })

  it('reads the published bytes as strict UTF-8: a byte-order mark or a broken byte is refused', () => {
    const bytes = new TextEncoder().encode(serializeManifest(buildManifest(base)))
    expect(parseManifest(bytes).version).toBe('0.22.0')
    expect(() => parseManifest(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]))).toThrow(/not JSON|canonical/)
    const broken = new Uint8Array(bytes); broken[bytes.length - 3] = 0xff
    expect(() => parseManifest(broken)).toThrow(/UTF-8/)
  })

  it('refuses one header named twice in different case', () => {
    expect(() => buildManifest({ ...base, headers: { 'X-A': '1', 'x-a': '2' } })).toThrow(/twice/)
  })

  it('fingerprints the published bytes with SHA-256', async () => {
    const text = serializeManifest(buildManifest(base))
    expect(await fingerprint(text)).toBe(H(text))
  })

  it('hashes files and sizes them in bytes', async () => {
    const bytes = new TextEncoder().encode('héllo')
    expect(await hashFiles([{ path: 'a', bytes }])).toEqual([{ path: 'a', sha256: createHash('sha256').update(bytes).digest('hex'), size: 6 }])
  })

  it('writes a notes line that names the file and claims nothing about production', async () => {
    const m = buildManifest(base)
    const fp = H('x')
    expect(notesLine(m, fp)).toBe(`Web app v0.22.0 (commit aaaaaaa): web-manifest.json lists the SHA-256 of all 2 files of this build; the manifest's own SHA-256 is ${fp}.`)
    expect(() => notesLine(m, 'nope')).toThrow(/fingerprint/)
  })

  it('has no node: import, so the browser can load the same module (#605 steps 3-5)', () => {
    const src = readFileSync(new URL('../../scripts/web-manifest.mjs', import.meta.url), 'utf8')
    expect(src).not.toMatch(/^\s*import\b/m)
    expect(src).not.toMatch(/\brequire\(/)
  })
})

describe('what the writer reads from disk (#605)', () => {
  it('lists every regular file, dotfiles included, with relative paths', () => {
    const d = mkdtempSync(join(tmpdir(), 'kc-dist-'))
    mkdirSync(join(d, 'assets'))
    mkdirSync(join(d, 'videos'))
    writeFileSync(join(d, 'index.html'), 'i')
    writeFileSync(join(d, 'assets', 'a.js'), 'a')
    writeFileSync(join(d, 'videos', '.gitkeep'), '')
    expect(listDist(d).map((f: { path: string }) => f.path)).toEqual(['assets/a.js', 'index.html', 'videos/.gitkeep'])
    symlinkSync(join(d, 'index.html'), join(d, 'link.html'))
    expect(() => listDist(d)).toThrow(/symlink/)
  })

  it('reads the headers ui/vercel.json sets on every path, from the real file', () => {
    const h = headersFromVercelJson(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
    expect(Object.keys(h).sort()).toEqual(['Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options'])
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(() => headersFromVercelJson('{"headers":[]}')).toThrow(/one header rule/)
  })

  it('records the VITE_* variables of the build and nothing else', () => {
    expect(buildEnv({ VITE_A: 'x', PATH: '/bin', VITE_B: 'y', SECRET: 's' })).toEqual({ VITE_A: 'x', VITE_B: 'y' })
  })

  it('refuses to describe a build that names another version or commit', () => {
    const vj = (o: object) => [{ path: 'version.json', bytes: new TextEncoder().encode(JSON.stringify(o)) }]
    expect(identityMismatch(vj({ version: '0.22.0', commit: 'aaaaaaa' }), '0.22.0', C)).toBeNull()
    expect(identityMismatch(vj({ version: '0.22.0', commit: 'bbbbbbb' }), '0.22.0', C)).toMatch(/commit bbbbbbb/)
    expect(identityMismatch(vj({ version: '0.21.0', commit: 'aaaaaaa' }), '0.22.0', C)).toMatch(/version 0.21.0/)
    expect(identityMismatch([], '0.22.0', C)).toMatch(/no version.json/)
  })
})
