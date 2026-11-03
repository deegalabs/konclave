/// <reference types="node" />
// A test that signs a vector signs it against the device's own clock: WASM reads `Date.now()` and
// the vector's expiry has to sit in the window that clock allows. Left on the real clock, those tests
// pass until the wall clock passes the NU7 activation (block 3,543,405, about 6 November 2026), and
// then every one of them fails on the same day, in CI too: the NU6.3 vector is a transaction the
// device, correctly, no longer accepts. So a test that builds a vector's expiry pins the clock to a
// fixed instant well inside the NU6.3 epoch (`pinClock`, in test-vectors.ts).
//
// The vector is not the only thing that reads the clock. The device's record of what it signed
// (`recordSigned`, `decideFor`, `new OwnerSigning`) asks WASM whether an earlier transaction can still
// be mined, and that answer changes the day the clock passes the upgrade: a test of "a second
// transaction is refused while the first is alive" stops being true there. `owner-signing.test.ts`
// signed no vector, so a scan for the expiry helpers alone never saw it, and from the upgrade on it
// failed. So the scan also names these three.
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

const SRC = new URL('.', import.meta.url).pathname

describe('tests that sign a vector pin the clock', () => {
  const files = readdirSync(SRC).filter((f) => /\.test\.tsx?$/.test(f) && f !== 'clock-pin.test.ts')
  const signing = files.filter((f) => {
    return /(withExpiry|honestExpiry|recordSigned|decideFor)\(|new OwnerSigning\(/.test(codeOf(`./${f}`))
  })

  it('finds the tests that sign a vector', () => {
    expect(signing.length, 'the scan found no test that signs a vector or reads what the device signed').toBeGreaterThan(0)
  })

  it.each(signing)('%s pins the clock before it signs', (f) => {
    const text = codeOf(`./${f}`)
    // A call, not a mention: an import with no call satisfies a looser pattern and keeps the file on the real clock.
    expect(text, `${f} signs a vector on the real clock`).toMatch(/beforeAll\(\s*pinClock\s*\)|\bpinClock\(\)/)
    expect(text, `${f} never gives the real clock back`).toMatch(/afterAll\(\s*unpinClock\s*\)|\bunpinClock\(\)/)
  })
})
