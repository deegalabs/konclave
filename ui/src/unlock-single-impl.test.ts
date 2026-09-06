import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Opening a share is three lines - `loadVault` -> `setUnlockedShare` -> `markVaultUnlocked` - and
// that is exactly why it kept being written out again instead of called.
//
// It had THREE implementations at once: the vault picker, the signing panel, and (nearly) #467's
// lock overlay. Each looked like a two-minute inline, none was wrong on its own, and a change to
// the rule would have had to find all of them. That is the failure this repo keeps paying for, and
// a test that merely checks the shared function works cannot see it: every copy would pass too.
//
// So this asserts the SHAPE instead: the sequence exists in one file. A fourth copy fails here the
// moment it is written, which is cheaper than discovering it after the rule changes.

const SRC = new URL('.', import.meta.url).pathname
const HOME = 'unlock.ts' // the one file allowed to contain it

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { sources(p, out); continue }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('opening a share has one implementation', () => {
  it('only unlock.ts puts a freshly loaded share into the session', () => {
    const offenders = sources(SRC)
      .filter((p) => !p.endsWith(HOME))
      .filter((p) => {
        // PROXIMITY, not mere co-occurrence. Holding both symbols somewhere in a 900-line file
        // proves nothing: `NetVault` legitimately does both far apart - it seats a share the DKG
        // just produced (never loaded), and elsewhere loads a vault into the ceremony's own state
        // without touching the session. What marks a COPY is `setUnlockedShare` applied to what
        // `loadVault` just returned, and those are always written together.
        //
        // The limit, stated rather than hidden: a copy that spread the two calls far apart would
        // slip through. Nobody writes it that way, and a cheap check that catches the shape which
        // actually recurred four times beats an exact one nobody maintains.
        const lines = readFileSync(p, 'utf8').split('\n')
        const at = (re: RegExp) => lines.flatMap((l, i) => (re.test(l) ? [i] : []))
        const loads = at(/\bloadVault\s*\(/)
        const seats = at(/\bsetUnlockedShare\s*\(/)
        return loads.some((a) => seats.some((b) => Math.abs(a - b) <= 3))
      })
      .map((p) => relative(SRC, p))

    expect(
      offenders,
      `these re-implement unlockOnDevice instead of calling it: ${offenders.join(', ')}`,
    ).toEqual([])
  })
})
