/// <reference types="node" />
import { describe, expect, inject, it, vi } from 'vitest'
// #669: two tests below walk and parse EVERY source file (3.6 s idle for the import-line one), so
// under load they cross the 5 s default. Raised for this file only; the global limit stays.
vi.setConfig({ testTimeout: 30_000 })
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { codeAt, parseCount, stripCacheKey, stripComments, stripCommentsOnce } from './source-scan'
import { SCAN_ROOTS, SKIPPED_DIRS } from './test-setup/strip-cache'

// The helper that source pins rely on has to remove comments and nothing else. A version built on
// regular expressions removed every import of api.ts (a `/*` inside a string opened a "comment"),
// and kept a `//` comment glued to code, so a disguised call could still satisfy a pin.
describe('stripComments', () => {
  it('removes line, block, trailing, glued and JSX comments', () => {
    const src = [
      '// a line comment naming oldCall()',
      'const a = 1 /* block oldCall() */ + 2',
      "const b = wrap(x)//new BackgroundSession({ decideApproval,",
      'const c = <div>{/* oldCall() */}<b>keep</b></div>',
    ].join('\n')
    const out = stripComments('x.tsx', src)
    expect(out).not.toContain('oldCall')
    expect(out).not.toContain('decideApproval')
    expect(out).toContain('const b = wrap(x)')
    expect(out).toContain('<b>keep</b>')
  })

  it('keeps a comment marker inside a string or a regex', () => {
    const src = "const g = '/api/*.json'\nconst h = 'https://x.y/z'\nconst r = /a\\/\\*b/\nconst after = 1 // gone"
    const out = stripComments('x.ts', src)
    expect(out).toContain("'/api/*.json'")
    expect(out).toContain("'https://x.y/z'")
    expect(out).toContain('const r = /a\\/\\*b/')
    expect(out).toContain('const after = 1')
    expect(out).not.toContain('gone')
  })

  it('keeps code after a comment marker inside a string, and JSX text that starts with one', () => {
    const src = [
      "const g = '/api/*'",
      'const keepMe = 1',
      '/* real */',
      "const u = 'a //b'; const keep2 = 2",
      'const el = <p>// not a comment</p>',
      'const after = <b>after</b>',
    ].join('\n')
    const out = stripComments('x.tsx', src)
    expect(out).toContain('const keepMe = 1')
    expect(out).toContain('const keep2 = 2')
    expect(out).toContain('<p>// not a comment</p>')
    expect(out).toContain('const after = <b>after</b>')
    expect(out).not.toContain('real')
  })

  it('does not read a comment marker inside a JSDoc block as a comment of its own', () => {
    const out = stripComments('e.ts', '/** @returns // x */ keepE()')
    expect(out).toContain('keepE()')
    expect(out).not.toContain('@returns')
  })

  it('answers again, not from memory, when the same path holds different content', () => {
    expect(stripComments('m.ts', 'one() // x')).toContain('one()')
    expect(stripComments('m.ts', 'one() // x')).toContain('one()')
    const next = stripComments('m.ts', 'two() // x')
    expect(next).toContain('two()')
    expect(next).not.toContain('one()')
  })

  it('is the only comment stripper the tests use', () => {
    // Six tests kept their own pattern-based strippers after this one replaced them, and one let a
    // call hidden behind a '//' inside a string pass a pin on the money path (#610 closing check).
    const dir = new URL('./', import.meta.url)
    const offenders: string[] = []
    const walk = (sub: string) => {
      for (const e of readdirSync(new URL(sub, dir), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
        else if (/\.test\.tsx?$/.test(e.name) && e.name !== 'source-scan.test.ts') {
          const src = readFileSync(new URL(`${sub}${e.name}`, dir), 'utf8')
          if (src.includes('(\\/\\/|') || src.includes('\\/\\/.*$')) offenders.push(`${sub}${e.name}`)
        }
      }
    }
    walk('')
    expect(offenders).toEqual([])
  })

  it('finds its files with fileURLToPath, never with the pathname of a URL', () => {
    // `new URL(..., import.meta.url).pathname` is `/C:/...` on Windows, which no file API opens:
    // 34 test files failed there before reaching an assertion (#887, #889). `fileURLToPath` is the
    // same path on Linux and the right one on Windows.
    const offenders: string[] = []
    const walk = (dir: URL, sub: string) => {
      for (const e of readdirSync(new URL(sub, dir), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(dir, `${sub}${e.name}/`) }
        else if (/\.(test|spec)\.tsx?$/.test(e.name) && e.name !== 'source-scan.test.ts') {
          const src = readFileSync(new URL(`${sub}${e.name}`, dir), 'utf8')
          if (/import\.meta\.url\s*\)\s*\.pathname/.test(src)) offenders.push(`${sub}${e.name}`)
        }
      }
    }
    walk(new URL('./', import.meta.url), '')
    walk(new URL('../', import.meta.url), 'e2e/')
    expect(offenders).toEqual([])
  })

  it('reads TypeScript source only through it', () => {
    // A guard that looks for the spelling of a stripper misses a test with none at all: twelve
    // read TS source raw, among them pins on the money path that a comment naming the old call
    // satisfied (#626 review). So a test that reads files either goes through source-scan or is
    // listed here with what it reads instead.
    const NOT_TS_SOURCE: Record<string, string> = {
      'contrast.test.ts': 'stylesheets',
      'creation-crossing.test.ts': 'the crossing fixture and the wasm',
      'layering.test.ts': 'stylesheets',
      'layout-width.test.ts': 'stylesheets',
      'viewing-code-wrap.test.ts': 'stylesheets',
      'settings-no-index-css.test.ts': 'stylesheets',
      'only-pnpm.test.ts': 'package.json and .npmrc',
      'changelog-gate.test.ts': 'CHANGELOG files',
      'changelog-shape.test.ts': 'CHANGELOG files',
      'changelog-sections.test.ts': 'CHANGELOG files',
      'changelog-fragments.test.ts': 'CHANGELOG files',
      'release-notes-shared.test.ts': 'CHANGELOG files',
      'release-pages.dom.test.tsx': 'CHANGELOG files',
      'net-room.test.ts': 'raw bytes, for control characters',
      'wasm-pkg-freshness.test.ts': 'Rust source and generated declarations',
      'wasm-write-actions.test.ts': 'the WASM binary and Rust source',
      'wasm-bridge.test.ts': 'the WASM binary and test vectors',
      'room-auth.test.ts': 'the WASM binary',
      'background-signer.test.ts': 'the WASM binary',
      'background-session.test.ts': 'the WASM binary',
      'device-key.test.ts': 'the WASM binary',
      'net-sign.test.ts': 'the WASM binary',
      'net-flow.test.ts': 'the WASM binary',
      'dkg-relay.test.ts': 'the WASM binary',
      'public-text-610.test.ts': 'documentation and the in-app copy, read as text',
      'who-sends.test.ts': 'the WASM binary',
      'release-notes-commits.test.ts': 'cliff.toml',
      'signed-record.test.ts': 'the WASM binary',
      'owner-signing.test.ts': 'the WASM binary',
      'epoch-reply.test.ts': 'Rust source (the coordinator\'s reasons)',
      'golden-vectors.test.ts': 'Rust source and the signers\' test vectors',
      'desktop-bundle-check.test.ts': 'the desktop release workflow and tauri.conf.json',
    }
    const dir = new URL('./', import.meta.url)
    const unlisted: string[] = []
    const walk = (sub: string) => {
      for (const e of readdirSync(new URL(sub, dir), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
        else if (/\.test\.tsx?$/.test(e.name) && e.name !== 'source-scan.test.ts') {
          const src = readFileSync(new URL(`${sub}${e.name}`, dir), 'utf8')
          if (src.includes('readFileSync') && !src.includes('source-scan') && !(e.name in NOT_TS_SOURCE)) {
            unlisted.push(`${sub}${e.name}`)
          }
        }
      }
    }
    walk('')
    expect(unlisted).toEqual([])
  })

  it('reads no TypeScript file raw, in any test, whatever else the test imports', () => {
    // The guard above looks at the file: one import of source-scan exempted every read in it, and
    // six pins kept reading source raw (so a comment could satisfy them). This one looks at each
    // call: a read that names a .ts or .tsx path goes through source-scan, except the generated
    // package, which is no source of ours.
    const dir = new URL('./', import.meta.url)
    const offenders: string[] = []
    const walk = (sub: string) => {
      for (const e of readdirSync(new URL(sub, dir), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
        else if (/\.test\.tsx?$/.test(e.name) && e.name !== 'source-scan.test.ts') {
          const text = readFileSync(new URL(`${sub}${e.name}`, dir), 'utf8')
          const sf = ts.createSourceFile(e.name, text, ts.ScriptTarget.Latest, true, e.name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
          const visit = (n: ts.Node) => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'readFileSync') {
              const arg = n.arguments[0]?.getText(sf) ?? ''
              if (/\.tsx?['"`]/.test(arg) && !arg.includes('wasm-pkg')) {
                offenders.push(`${sub}${e.name}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  ${arg.slice(0, 70)}`)
              }
            }
            n.forEachChild(visit)
          }
          visit(sf)
        }
      }
    }
    walk('')
    expect(offenders, `these read TypeScript source raw; use codeOf or codeAt:\n${offenders.join('\n')}`).toEqual([])
  })

  it('keeps every import line of every source file', () => {
    const dir = new URL('./', import.meta.url)
    const files: string[] = []
    const walk = (sub: string) => {
      for (const e of readdirSync(new URL(sub, dir), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(`${sub}${e.name}`)
      }
    }
    walk('')
    expect(files.length).toBeGreaterThan(100)
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      const imports = src.split('\n').filter((l) => /^import /.test(l))
      const out = stripComments(f, src)
      for (const line of imports) expect(out, `${f} lost: ${line}`).toContain(line)
    }
  })
})

// The run-wide cache (test-setup/strip-cache.ts, #957). Every scan walks the tree itself; what is
// cached is only the stripped content, keyed by the source's kind and hash, so it cannot be stale.
describe('the strip cache', () => {
  const cacheFile = () => inject('stripCache')
  const entries = () => JSON.parse(readFileSync(cacheFile(), 'utf8')) as Record<string, string>
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const treeSources = () => {
    const found: { name: string; src: string }[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIPPED_DIRS.has(e.name)) walk(join(dir, e.name)) }
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) found.push({ name: e.name, src: readFileSync(join(dir, e.name), 'utf8') })
      }
    }
    for (const r of SCAN_ROOTS) walk(join(repoRoot, r))
    return found
  }

  it('keys a source by its kind as well as its text: the same text strips differently as TS and as TSX', () => {
    expect(stripCacheKey('a.ts', 'const a = 1')).not.toBe(stripCacheKey('a.tsx', 'const a = 1'))
    expect(stripCacheKey('a.ts', 'const a = 1')).toBe(stripCacheKey('b.ts', 'const a = 1'))
  })

  it('is on in this run: a readable file with the sources of the tree', () => {
    // Without the globalSetup every scan falls back to parsing, silently: green, and slow again.
    expect(cacheFile(), 'vite.config.ts test.globalSetup gives the workers a cache').toBeTruthy()
    expect(Object.keys(entries()).length).toBeGreaterThan(100)
  })

  it('holds, for every source of the tree, exactly what the one rule returns', () => {
    const cache = entries()
    const sources = treeSources()
    expect(sources.length).toBeGreaterThan(100)
    const missing: string[] = []
    const wrong: string[] = []
    sources.forEach(({ name, src }) => {
      const key = stripCacheKey(name, src)
      // A source edited after the setup has no entry: in watch mode, restart vitest after an edit.
      if (!(key in cache)) { missing.push(name); return }
      // All of them, not a sample: a sample missed the one corrupted entry in a red-check.
      if (cache[key] !== stripCommentsOnce(name, src)) wrong.push(name)
    })
    expect(missing).toEqual([])
    expect(wrong).toEqual([])
  })

  it('serves the tree without parsing it, and parses a source it does not hold', () => {
    const before = parseCount()
    // Under a name no other test uses, so the per-path memo cannot answer for the cache.
    // Only sources the cache holds (one edited since the setup, in watch mode, is rightly parsed).
    const cache = entries()
    const held = treeSources().filter(({ name, src }) => stripCacheKey(name, src) in cache).slice(0, 40)
    expect(held.length).toBe(40)
    for (const { name, src } of held) stripComments(`probe/${name}`, src)
    expect(parseCount() - before, 'a source of the tree comes from the cache').toBe(0)

    // A file created during the run is not in the cache: it is parsed, and the call in it is seen.
    const dir = mkdtempSync(join(tmpdir(), 'konclave-scan-'))
    try {
      const name = 'zap' + 'Call'
      const file = join(dir, 'new.ts')
      writeFileSync(file, `// ${name}() in a comment\nx.${name}()\n`)
      expect(codeAt(file)).toMatch(new RegExp('\\.' + name + '\\s*\\('))
      expect(parseCount() - before).toBe(1)
      // The same path edited: parsed again, so the pin sees the new code, not the old.
      writeFileSync(file, `// x.${name}()\nconst a = 1\n`)
      expect(codeAt(file)).not.toContain(name)
      expect(parseCount() - before).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
