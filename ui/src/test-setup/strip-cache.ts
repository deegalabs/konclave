/// <reference types="node" />
// A vitest globalSetup (vite.config.ts test.globalSetup). About thirty test files walk every source
// and strip its comments with the TypeScript parser, and vitest gives each test file its own module
// instance, so a full run parsed about 5000 times and the scans timed out under load (#957). This strips
// each source ONCE, with the same function the scans use (`stripCommentsOnce`, no second copy of the
// rule), and hands the workers the result.
//
// Only stripped content is cached. The scans still walk the file list themselves on every run, and a
// source that is not in the cache (created or edited during the run) is parsed by the scan.
// The file lives in a fresh temp directory per run, its path reaches the workers only through
// `provide`, and teardown removes it. An interrupted run (Ctrl-C) skips teardown and leaves the
// directory behind: it holds only the repository's own sources, without their comments.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'
import { stripCacheKey, stripCommentsOnce } from '../source-scan'

declare module 'vitest' {
  export interface ProvidedContext {
    stripCache: string
  }
}

// The roots the scans read, from the repository root.
export const SCAN_ROOTS = ['ui/src', 'sdk/src', 'sdk/examples']
export const SKIPPED_DIRS = new Set(['wasm-pkg', 'node_modules', 'dist', 'pkg'])

export default function setup(project: TestProject) {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const entries: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(join(dir, e.name))
      } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        const src = readFileSync(join(dir, e.name), 'utf8')
        entries[stripCacheKey(e.name, src)] = stripCommentsOnce(e.name, src)
      }
    }
  }
  for (const r of SCAN_ROOTS) walk(join(root, r))
  const dir = mkdtempSync(join(tmpdir(), 'konclave-strip-'))
  const file = join(dir, 'strip.json')
  writeFileSync(file, JSON.stringify(entries))
  project.provide('stripCache', file)
  return () => rmSync(dir, { recursive: true, force: true })
}
