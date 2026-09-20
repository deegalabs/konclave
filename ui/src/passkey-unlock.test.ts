import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { unlockWithPasskeyUsing, UNLOCK_TIMEOUT_MS, type PasskeyUnlockDeps } from './passkey-unlock'

// #469 unified the passkey BUTTON across the two unlock surfaces and left the handler behind it
// duplicated: `LockOverlay.withPasskey` and `Vaults.unlockWithPasskey` were the same twelve lines
// in two files. Two implementations of one rule, with only one of them fixed, is what this repo
// keeps paying for - so the handler is one function and this holds it there.
const SRC = new URL('.', import.meta.url).pathname
const HOME = 'passkey-unlock.ts'
const DEFINES = 'prf-wrap.ts'

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { sources(p, out); continue }
    if (!/\.tsx?$/.test(e) || /\.test\.tsx?$/.test(e) || e === DEFINES || e === HOME) continue
    out.push(p)
  }
  return out
}

const codeOf = (p: string) =>
  readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const WRAP = { credentialId: 'AQID', salt: 'aa', iv: 'bb', cipher: 'cc' }

function deps(over: Partial<PasskeyUnlockDeps> = {}) {
  const calls: string[] = []
  return {
    calls,
    loadPrfWrap: () => WRAP,
    openPrf: async () => new Uint8Array(32).fill(7),
    setReadSecret: (id: string) => { calls.push(`setReadSecret:${id}`) },
    markVaultUnlocked: (id: string) => { calls.push(`markVaultUnlocked:${id}`) },
    ...over,
  } as unknown as PasskeyUnlockDeps & { calls: string[] }
}

describe('opening a vault with the passkey', () => {
  it('seats `S` and marks the vault unlocked', async () => {
    const d = deps()
    expect(await unlockWithPasskeyUsing(d, 'V', 'konclave.xyz', {} as never)).toBe('unlocked')
    expect(d.calls).toEqual(['setReadSecret:V', 'markVaultUnlocked:V'])
  })

  it('reports a refusal instead of returning silently', async () => {
    // The behaviour this change exists for. `openPrf` answers null for every cause on purpose, and
    // the screen used to do NOTHING with that: the button said "waiting" for up to a minute and
    // then went back to normal, leaving the member on the same locked dialog with no idea whether
    // anything had happened. Silent must mean "no alarming copy", not "no answer".
    const d = deps({ openPrf: async () => null })
    expect(await unlockWithPasskeyUsing(d, 'V', 'konclave.xyz', {} as never)).toBe('refused')
    expect(d.calls, 'a refusal must not half-unlock the vault').toEqual([])
  })

  it('does not claim a refusal when this device simply has no wrap', async () => {
    const d = deps({ loadPrfWrap: () => null })
    expect(await unlockWithPasskeyUsing(d, 'V', 'konclave.xyz', {} as never)).toBe('no-wrap')
  })

  it('waits less than an enrolment does', async () => {
    // Enrolling asks the member to read a system sheet and decide; opening is a touch they either
    // give at once or do not give at all. A minute of a spinning button is not patience.
    const seen: number[] = []
    const d = deps({ openPrf: async (_a, _w, _r, ms?: number) => { seen.push(ms ?? -1); return null } })
    await unlockWithPasskeyUsing(d, 'V', 'konclave.xyz', {} as never)
    expect(seen).toEqual([UNLOCK_TIMEOUT_MS])
    expect(UNLOCK_TIMEOUT_MS).toBeLessThan(60_000)
  })

  it('leaves a trace a maintainer can read, without showing the member an error', async () => {
    // Asked for directly: "tem como eu ver no console?" The answer used to be no, because every
    // cause collapsed to null and nothing logged it.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await unlockWithPasskeyUsing(deps({ openPrf: async () => null }), 'V', 'konclave.xyz', {} as never)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('nothing but passkey-unlock.ts calls openPrf', () => {
    const offenders = sources(SRC).filter((p) => /\bopenPrf\s*\(/.test(codeOf(p)))
    expect(
      offenders.map((p) => p.replace(SRC, '')),
      'a second passkey-unlock handler, which is how the first one drifted',
    ).toEqual([])
  })
})
