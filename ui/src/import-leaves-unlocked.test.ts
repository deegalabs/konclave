import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Importing a vault must leave it USABLE, and how this was missed matters more than the bug.
//
// The import screen decrypted the export with the member's passphrase, wrote the vault to
// IndexedDB, and left the session empty. The seat was then inert - the signer needs the share and
// every private read needs `S`, and both live only in the session. `unlock.ts` predicts it exactly:
// "Anything that skipped setUnlockedShare would look unlocked and 401 on every read."
//
// `unlock-single-impl.test.ts` could not catch it. That guard forbids a SECOND implementation; this
// was a MISSING one, and doing nothing breaks no uniqueness rule.
//
// THE FIRST VERSION OF THIS TEST DID NOT CATCH IT EITHER, and that is the part worth keeping. It
// asked whether a file calling `importVault` also called `unlockOnDevice` - and `Vaults.tsx` did,
// in an unrelated flow further down. The scan was satisfied by a call site that had nothing to do
// with importing. Red-checking it is the only reason that was found: with the fix reverted, it
// still passed.
//
// So the pairing is now STRUCTURAL - one `importAndUnlock` does both - and what is asserted here is
// uniqueness, which a scan can actually establish.
const SRC = new URL('.', import.meta.url).pathname
const HOME = 'unlock.ts' // the one file allowed to call importVault
const DEFINES = 'storage.ts' // where it is declared

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { sources(p, out); continue }
    if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e) || e === DEFINES || e === HOME) continue
    out.push(p)
  }
  return out
}

describe('importing a vault leaves it unlocked', () => {
  it('nothing but unlock.ts calls importVault', () => {
    const offenders = sources(SRC).filter((p) => {
      // Comments excluded: a scan its own commentary can satisfy measures nothing.
      const code = readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      return /\bimportVault\s*\(/.test(code)
    })
    expect(
      offenders.map((p) => p.replace(SRC, '')),
      'calls importVault directly, so it can import a vault and leave the seat unable to sign or read',
    ).toEqual([])
  })

  it('and unlock.ts pairs it with the unlock in one function', () => {
    const home = readFileSync(join(SRC, HOME), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    const fn = home.slice(home.indexOf('export async function importAndUnlock'))
    expect(fn, 'importAndUnlock is gone; the pairing is no longer structural').toBeTruthy()
    expect(/\bimportVault\s*\(/.test(fn) && /\bunlockOnDevice\s*\(/.test(fn),
      'importAndUnlock must do BOTH, or the name is a lie').toBe(true)
  })
})
