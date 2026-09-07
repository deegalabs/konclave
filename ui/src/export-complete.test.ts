import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// #447/#480, and the reason they were not enough.
//
// `exportVault(id, pass, ufvk?, birthday?)` has carried the viewing key and the scan floor since
// #447 and #480. The mechanism was right and its tests passed. What nobody checked was whether every
// CALLER used it: Settings did, and the create-vault screen did not, so the backup a member is
// handed the moment their vault exists - the copy most of them keep - restored the seat and not the
// vault. The 0.3.0 release notes said the export carried both. That was true of one caller.
//
// This is the same shape as `prf-reachable.test.ts` (a capability offered must be offered somewhere
// to CREATE) and `wasm-ready.test.ts` (one loader, not five). A rule with two call sites and one
// update is what this codebase keeps paying for, and a unit test on the mechanism cannot see it.
//
// Test files are excluded on purpose: counting them would let a test satisfy the guard and rebuild
// the blind spot the guard exists to close.

const SRC = new URL('.', import.meta.url).pathname

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'wasm-pkg' ? [] : sources(p)
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return []
    return [p]
  })
}

describe('every export a member is handed carries what a rebuild needs', () => {
  // `storage.ts` DEFINES exportVault; a definition is not a call site.
  const callers = sources(SRC).filter(
    (p) => !p.endsWith('storage.ts') && /\bexportVault\(/.test(readFileSync(p, 'utf8')),
  )

  it('there is at least one caller, or this test is guarding nothing', () => {
    expect(callers.length).toBeGreaterThan(0)
  })

  it.each(callers.map((p) => [p.slice(SRC.length), p] as const))(
    '%s passes the viewing key and the scan floor',
    (_rel, path) => {
      const src = readFileSync(path, 'utf8')
      // Two arguments is `exportVault(id, passphrase)` and nothing else: the seat, not the vault.
      const bare = [...src.matchAll(/\bexportVault\(([^)]*)\)/g)].filter(
        (m) => m[1]!.split(',').length < 3,
      )
      expect(
        bare.map((m) => m[0]),
        'exportVault called with no viewing key: that backup restores the seat, not the vault (#447/#480)',
      ).toEqual([])
    },
  )
})
