import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { deriveRoom, newInviteCode, parseInvite, inviteLink, joinParam, INVITE_LENGTH } from './net'

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
    // Version 2 (konclave-room-v2): a device on the previous version derives another room.
    ['ABCD1234', '1234', '154251e12f579d8b11e2f9b44f997bf5'],
    ['ROOM-X', 'hunter2', '2c6d69e75748f417de9e6984163df6fa'],
    ['a', '  spaced  ', '0360e41e46d51f498078adc45e56f187'],
  ])('code %s + pin %s derives its version-2 room', async (code, pin, want) => {
    expect(await deriveRoom(code, pin)).toBe(want)
  })

  it('refuses to derive a room without a PIN', async () => {
    await expect(deriveRoom('ABCD1234', '')).rejects.toThrow()
    await expect(deriveRoom('ABCD1234', '   ')).rejects.toThrow()
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

describe('the vault-creation invite', () => {
  it('is 128 bits or more of base32, fresh each time', () => {
    const a = newInviteCode()
    expect(a).toMatch(new RegExp(`^[0-9A-HJKMNP-TV-Z]{${INVITE_LENGTH}}$`))
    expect(INVITE_LENGTH * 5).toBeGreaterThanOrEqual(128)
    expect(newInviteCode()).not.toBe(a)
  })

  it('is read back from a link, a grouped code, or the code itself, and nothing else', () => {
    const code = newInviteCode()
    expect(parseInvite(inviteLink(code, 'https://example.test/'))).toBe(code)
    expect(parseInvite(code.match(/.{1,4}/g)!.join('-').toLowerCase())).toBe(code)
    expect(parseInvite(code.slice(1))).toBeNull()
    expect(parseInvite(code.slice(1) + 'I')).toBeNull() // I is not in the alphabet
  })

  it('a malformed link is no invite, never a crash', () => {
    expect(parseInvite('#/vaults?join=%E0%A4%A')).toBeNull()
    expect(parseInvite('#/vaults?join=%')).toBeNull()
    expect(joinParam('#/vaults?join=%E0%A4%A')).toBeNull()
  })

  it('opens the vaults screen\'s join dialog, where a joiner gets what the creator gets', () => {
    expect(inviteLink('X'.repeat(INVITE_LENGTH), 'https://example.test/')).toBe(`https://example.test/#/vaults?join=${'X'.repeat(INVITE_LENGTH)}`)
  })

  it('puts the code only in the fragment, never in a query a server would see', () => {
    const link = inviteLink('X'.repeat(INVITE_LENGTH), 'https://example.test/')
    expect(new URL(link).search).toBe('')
    expect(new URL(link).hash).toContain('join=')
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
