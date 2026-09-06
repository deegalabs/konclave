import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The passkey shortcut shipped DEAD, and nothing caught it (#468).
//
// `Vaults.tsx` read `loadPrfWrap` and called `openPrf`, so the "Unlock with this device" button was
// wired, tested and present in the production bundle. But `enrolPrf` and `savePrfWrap` were called
// only from `prf-wrap.test.ts`. No screen ever created a wrap, so `loadPrfWrap` always returned
// null, the button could never render, and the whole feature was unreachable while every test
// passed - because the tests called the enrolment directly, skipping the screens entirely.
//
// The rule this encodes: a capability the UI offers to USE must be offered somewhere to CREATE.
// A source scan is the only place to ask that, since the two halves live in different screens and
// no unit test spans them. It is the same shape as `css-classes-exist` and `wasm-pkg-freshness`.

const SRC = new URL('.', import.meta.url).pathname

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { sources(p, out); continue }
    // Tests are excluded ON PURPOSE: a test calling `enrolPrf` is exactly what made the dead
    // feature look alive. Counting them here would rebuild the blind spot.
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

/** Files that USE a capability, and files that DEFINE it - the definition never counts as a use. */
function callers(symbol: string): string[] {
  const re = new RegExp(`\\b${symbol}\\s*\\(`)
  return sources(SRC)
    .filter((p) => !p.endsWith('prf-wrap.ts') && !p.endsWith('prf-store.ts'))
    .filter((p) => re.test(readFileSync(p, 'utf8')))
}

describe('the passkey shortcut is reachable', () => {
  it('some screen enrols a passkey, not only the tests', () => {
    const who = callers('enrolPrf')
    expect(who, 'no screen calls enrolPrf: the unlock button can never appear').not.toHaveLength(0)
  })

  it('some screen stores the wrap it enrolled', () => {
    // An enrolment that is not saved is worse than none: the member is prompted by their
    // authenticator, it succeeds, and the shortcut still never appears.
    expect(callers('savePrfWrap'), 'nothing calls savePrfWrap').not.toHaveLength(0)
  })

  it('the shortcut can be given up as well as taken on', () => {
    // A one-way switch on a per-device security setting is a trap: a shared or lost-then-found
    // machine must be able to drop the wrap without deleting the vault.
    expect(callers('clearPrfWrap'), 'nothing calls clearPrfWrap').not.toHaveLength(0)
  })
})
