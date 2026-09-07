import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { deriveRoom } from './net'

// Two things, and the second is why this file exists at all.
//
// 1. GOLDEN VECTORS. `deriveRoom` decides which relay room a vault's ceremony happens in. Change its
//    input by one byte and every device computes a different room: the members never meet, and a
//    live ceremony would simply stop finding its peers. These values were computed from the source
//    BEFORE the escaping change below, so they pin the behaviour across it.
//
// 2. THE FILE MUST STAY TEXT. `net.ts` used to carry two literal NUL bytes - the domain separators
//    in the hash input, which is correct cryptography and the wrong way to write it. The effect was
//    that `file` reported the source as `data` and every `grep -r` skipped it SILENTLY. Not "found
//    nothing": produced no output and exited as if the file had been searched.
//
//    That file is the one the docs repeatedly call the diverged second implementation - #363, #424
//    and #425 all live in it - so the one source a reviewer most needs to search was the one source
//    a search could not see. It cost a wrong conclusion in review before anyone noticed.
//
//    An escaped NUL in a template literal produces the identical byte at runtime, which is what the
//    vectors above prove, and leaves the file greppable.

describe('deriveRoom', () => {
  it.each([
    ['ABCD1234', '1234', 'ac9c03ec13b2fe1e51d1192173a058d7'],
    ['ROOM-X', 'hunter2', 'd5409075b4669430a3e3e73a38a8d15d'],
    ['a', '  spaced  ', '0c328d145982619fff085bcdc3e06cba'],
  ])('code %s + pin %s derives the same room it always has', async (code, pin, want) => {
    expect(await deriveRoom(code, pin)).toBe(want)
  })

  it('with no pin the room IS the code, so an unpinned vault is unchanged', async () => {
    expect(await deriveRoom('ABCD1234', '')).toBe('ABCD1234')
    expect(await deriveRoom('ABCD1234', '   ')).toBe('ABCD1234')
  })

  it('the pin actually separates rooms', async () => {
    expect(await deriveRoom('SAME', '1')).not.toBe(await deriveRoom('SAME', '2'))
  })

  // The separator is what stops ("ab","c") and ("a","bc") colliding. Worth an assertion rather than
  // trust, since the escaping change touched exactly those two bytes.
  it('the domain separator prevents a code/pin boundary collision', async () => {
    expect(await deriveRoom('ab', 'c')).not.toBe(await deriveRoom('a', 'bc'))
  })
})

// Every source under ui/src, not just `net.ts`. Writing this test is what proved the wider scope is
// needed: the FIRST version of this very file carried a raw NUL of its own, in the comment above
// explaining why they are forbidden, and `git` reported it as `Bin 0 -> 2998 bytes`. A guard that
// polices one file while the next one drifts is the shape of defect this repo keeps paying for.
describe('the sources under ui/src', () => {
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return e.name === 'wasm-pkg' ? [] : walk(p)
      return /\.tsx?$/.test(e.name) ? [p] : []
    })
  })(new URL('.', import.meta.url).pathname)

  it.each(files.map((f) => [f.split('/ui/src/')[1] ?? f, f] as const))(
    '%s has no raw control bytes, so grep can still see it',
    (_rel, path) => {
      const raw = readFileSync(path)
      const offenders = [...raw].filter((b) => b < 0x09 || (b > 0x0d && b < 0x20))
      expect(
        offenders.length,
        'a raw control byte makes `file` report this source as binary, and every grep -r skips it ' +
          'silently - which is how the diverged ceremony driver became unsearchable. Escape it.',
      ).toBe(0)
    },
  )
})
