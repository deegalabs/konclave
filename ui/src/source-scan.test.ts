/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { stripComments } from './source-scan'

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

  it('reads TypeScript source only through it', () => {
    // A guard that looks for the spelling of a stripper misses a test with none at all: twelve
    // read TS source raw, among them pins on the money path that a comment naming the old call
    // satisfied (#626 review). So a test that reads files either goes through source-scan or is
    // listed here with what it reads instead.
    const NOT_TS_SOURCE: Record<string, string> = {
      'contrast.test.ts': 'stylesheets',
      'layering.test.ts': 'stylesheets',
      'layout-width.test.ts': 'stylesheets',
      'only-pnpm.test.ts': 'package.json and .npmrc',
      'changelog-gate.test.ts': 'CHANGELOG files',
      'changelog-shape.test.ts': 'CHANGELOG files',
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
      'public-text-610.test.ts': 'documentation and the in-app copy, read as text',
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
