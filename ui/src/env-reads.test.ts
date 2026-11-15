import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { codeAt } from './source-scan'

// #605: the web build must be reproducible from the repository, so that a rebuild at a release tag
// gives the bytes the host serves. Reading `import.meta.env` as a whole object makes Vite inline
// every VITE_* variable the build saw, including the ones the host adds on its own (Vercel injects
// VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG), and the bundle stops matching any build made elsewhere.
// A static read (`import.meta.env.VITE_HELPER_BASE`) inlines only that value. Test files are
// excluded: they never reach the bundle. Comments are stripped (source-scan), so a comment cannot
// hide a read or count as one.
const src = join(__dirname)
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'wasm-pkg' ? [] : files(p)
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
  })

// The members Vite defines itself, which are always replaced one by one.
const BUILT_IN = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL'])

describe('the app reads the build env one key at a time (#605)', () => {
  it('no source file reads import.meta.env except as import.meta.env.<NAME>', () => {
    const offenders: string[] = []
    for (const f of files(src)) {
      const text = codeAt(f)
      for (const m of text.matchAll(/import\.meta\.env\b(\.([A-Za-z_$][\w$]*))?/g)) {
        const name = m[2]
        if (name === undefined || !(BUILT_IN.has(name) || /^VITE_[A-Z0-9_]+$/.test(name))) {
          offenders.push(`${f.slice(src.length + 1)}: ${m[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
