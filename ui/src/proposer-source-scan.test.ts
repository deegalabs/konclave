/// <reference types="node" />
import { describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './source-scan'

// #591. Who proposes is decided in ONE place, `actingAs` in api.ts. A screen that chose a proposer
// from the first member (`member_list[0]`) or from the device's `myName` is what put every seat
// under seat 1's name. Tests are excluded; api.ts is the one named exception (the local bridge
// branch lives there).
const SRC = fileURLToPath(new URL('.', import.meta.url))
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return f === 'wasm-pkg' || f === 'node_modules' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
  })
}
const EXCEPTION = join(SRC, 'api.ts')

describe('no screen chooses a proposer from the first member or myName (#591)', () => {
  const files = walk(SRC).filter((p) => p !== EXCEPTION)
  const pins: [string, RegExp][] = [
    ['first0', /\bfirst0\b/],
    ['member_list[0] / member_list?.[0]', /member_list\??\.?\[\s*0\s*\]/],
    ['the Alice default', /useState\(\s*['"]Alice['"]\s*\)/],
    ['mine ?? ...name', /\bmine\s*\?\?/],
  ]
  it('finds source files to scan', () => { expect(files.length).toBeGreaterThan(20) })
  for (const [label, re] of pins) {
    it(`no file outside api.ts uses ${label}`, () => {
      const hits = files.filter((p) => re.test(stripComments(p, readFileSync(p, 'utf8'))))
      expect(hits, hits.join(', ')).toEqual([])
    })
  }
  it('no proposing screen reads myName', () => {
    for (const f of ['screens/NewPayment.tsx', 'screens/NewPayroll.tsx']) {
      expect(stripComments(f, readFileSync(join(SRC, f), 'utf8')), f).not.toMatch(/\bmyName\b/)
    }
  })
  it('both proposing screens ask actingAs', () => {
    for (const f of ['screens/NewPayment.tsx', 'screens/NewPayroll.tsx']) {
      expect(stripComments(f, readFileSync(join(SRC, f), 'utf8')), f).toMatch(/\bactingAs\(/)
    }
  })
})
