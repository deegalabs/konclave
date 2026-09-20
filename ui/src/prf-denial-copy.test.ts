import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DENIAL_COPY } from './prf-denial-copy'

// A denial the member cannot read is the defect this whole change exists to remove.
//
// #538 was two days of guessing because one sentence stood for four causes. Splitting them helps
// only if every cause HAS a sentence, in the member's language - and the keys live in two locale
// files while the map that names them lives in a third. `t()` falls back to the key, so a missing
// one does not throw: it puts `settings.passkeyNoPrf` on the screen, which is the vague message
// again, wearing a worse costume.
//
// Driven off `DENIAL_COPY` rather than a hardcoded list, so a denial added to `PrfDenial` is
// covered here the moment the build forces it into the map. A list would go stale in exactly the
// way this test exists to prevent.
const LOCALES = ['en.ts', 'pt-BR.ts']

describe('every enrolment denial has copy the member can read (#538)', () => {
  for (const locale of LOCALES) {
    const src = readFileSync(join(new URL('.', import.meta.url).pathname, 'i18n', locale), 'utf8')
    // Only DEFINITIONS. A key that appears solely inside a comment is not copy, and this repo has
    // twice shipped a guard that its own commentary satisfied.
    const defined = new Set(
      src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .flatMap((l) => Array.from(l.matchAll(/'([\w.]+)'\s*:/g), (m) => m[1]!)),
    )

    for (const [denial, key] of Object.entries(DENIAL_COPY)) {
      it(`${locale} defines the message for "${denial}"`, () => {
        expect(defined.has(key), `${locale} is missing ${key}, so the member would read the key itself`).toBe(true)
      })
    }
  }

  it('gives each denial a DIFFERENT message', () => {
    // The point of the change. Three keys pointing at one sentence would pass every test above and
    // rebuild the exact blind spot: a screen that cannot tell the member which thing happened.
    const keys = Object.values(DENIAL_COPY)
    expect(new Set(keys).size, 'two denials share a message, which is what #538 was').toBe(keys.length)
  })
})
