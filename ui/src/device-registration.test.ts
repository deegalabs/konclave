import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Registering this device's seat must not depend on a proposal being open.
//
// The write key (#288) is what lets a member VOTE. The gate is per VAULT and the keys are per SEAT,
// so the moment ANY member registers, every governance write on that vault must be signed -
// including from a seat that never registered and therefore cannot produce a signature anyone can
// verify. `authorize_write` answers `UnknownSeat`, the member gets a 401, and no screen can tell
// them why.
//
// It used to register inside `useBackgroundSigner`, which runs only while a proposal is OPEN. That
// is a DEADLOCK, not a delay: you need an open proposal to register, and a registered key to act on
// one. A live 2-of-3 vault sat there for a fortnight - the coordinator's key list held seats 1 and
// 2 and had not been written since the day those two registered, while the third member could
// approve nothing.
//
// Asserted as UNIQUENESS rather than as "the signer no longer calls it", because a scan for an
// absence is satisfied by any file that happens to mention the right symbol somewhere else. That
// exact mistake shipped in this repo this week and was caught only by red-checking it.
const SRC = new URL('.', import.meta.url).pathname
const HOME = 'device-registration.ts' // the one file allowed to call it
const DEFINES = 'helper.ts' // where registerDeviceKey is declared

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { sources(p, out); continue }
    if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e) || e === DEFINES || e === HOME) continue
    out.push(p)
  }
  return out
}

function codeOf(p: string): string {
  // Comments excluded: a scan its own commentary can satisfy measures nothing.
  return readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
}

describe('a seat registers on unlock, not on an open proposal', () => {
  it('nothing but device-registration.ts calls registerDeviceKey', () => {
    const offenders = sources(SRC).filter((p) => /\bregisterDeviceKey\s*\(/.test(codeOf(p)))
    expect(
      offenders.map((p) => p.replace(SRC, '')),
      'registers a seat somewhere other than the one place that is reached on every unlock',
    ).toEqual([])
  })

  it('the background signer does not register, since it only runs with a proposal open', () => {
    expect(/\bregisterDeviceKey\s*\(/.test(codeOf(join(SRC, 'useBackgroundSigner.ts'))))
      .toBe(false)
  })

  it('and the unlock path does register', () => {
    // The other half of the rule. Uniqueness alone would be satisfied by nobody calling it at all,
    // which is the state that produced the bug.
    expect(/\bregisterThisDevice\s*\(/.test(codeOf(join(SRC, 'unlock.ts'))))
      .toBe(true)
  })
})
