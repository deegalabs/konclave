import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { codeAt } from './source-scan'

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
const SRC = fileURLToPath(new URL('.', import.meta.url))
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

// Comments excluded, by the parser (source-scan.ts): a scan its own commentary can satisfy
// measures nothing.
const codeOf = codeAt

describe('a seat registers on unlock, not on an open proposal', () => {
  it('nothing but device-registration.ts registers a vault\'s read key, and only for a vault made by the current creation', () => {
    const offenders = sources(SRC).filter((p) => /\bregisterReadKey(?:Result)?\s*\(/.test(codeOf(p)))
      .map((p) => relative(SRC, p)).filter((p) => p !== 'device-registration.ts' && p !== DEFINES)
    expect(offenders).toEqual([])
    expect(codeOf(join(SRC, 'device-registration.ts'))).toMatch(/if \(share\.accessSecret && share\.threshold !== undefined\)/)
  })

  it('nothing but device-registration.ts calls registerDeviceKey', () => {
    const offenders = sources(SRC).filter((p) => /\bregisterDeviceKey(?:Result)?\s*\(/.test(codeOf(p)))
    expect(
      offenders.map((p) => p.replace(SRC, '')),
      'registers a seat somewhere other than the one place that is reached on every unlock',
    ).toEqual([])
  })

  it('the background signer does not register, since it only runs with a proposal open', () => {
    expect(/\bregisterDeviceKey(?:Result)?\s*\(/.test(codeOf(join(SRC, 'useBackgroundSigner.ts'))))
      .toBe(false)
  })

  it('a protocol 3 seat registers with its own certificate, and a refusal is carried up', () => {
    const src = codeOf(join(SRC, 'device-registration.ts'))
    expect(src).toMatch(/seatCertificateFromBundle\(b\.keyPackage, b\.pubkeys, b\.seat, b\.t, b\.n, share\.cp,/)
    expect(src).toMatch(/\}, proof\)/)
    expect(src.match(/return \{ refused: code \}/g)).toHaveLength(2)
    expect(codeOf(join(SRC, 'VaultSigner.tsx'))).toMatch(/&& !deviceRefusal\(vaultIdRef\.current\)/)
  })

  it('and the unlock path does register', () => {
    // The other half of the rule. Uniqueness alone would be satisfied by nobody calling it at all,
    // which is the state that produced the bug.
    expect(/\bregisterThisDevice\s*\(/.test(codeOf(join(SRC, 'unlock.ts'))))
      .toBe(true)
  })
})
