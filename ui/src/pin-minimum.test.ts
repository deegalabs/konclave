import { describe, it, expect, vi } from 'vitest'
import { codeOf } from './source-scan'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { deriveRoom, pinIsLongEnough, MIN_PIN_LENGTH } from './net'
import { InviteCard } from './screens/CeremonyParts'

// The room PIN is what keeps a holder of the invite alone out of the creation room. A short one is
// guessable, so the minimum lives once, in net.ts, and every way into a room goes through it:
// deriveRoom refuses a short PIN, and the forms ask the same function before enabling their button.
describe('room PIN minimum', () => {
  it('is six characters', () => {
    expect(MIN_PIN_LENGTH).toBe(6)
  })

  it('counts the PIN as typed, without the spaces around it', () => {
    expect(pinIsLongEnough('12345')).toBe(false)
    expect(pinIsLongEnough('  12345  ')).toBe(false)
    expect(pinIsLongEnough('123456')).toBe(true)
    expect(pinIsLongEnough(' 123456 ')).toBe(true)
  })

  // What counts is what a person can read out on a call: invisible characters add nothing, and a
  // character outside the basic plane is one character, not two.
  it('counts what a person can read out, not code units', () => {
    expect(pinIsLongEnough('\u200B'.repeat(6))).toBe(false)
    expect(pinIsLongEnough('12345\u200B')).toBe(false)
    expect(pinIsLongEnough('12345\uFEFF')).toBe(false)
    expect(pinIsLongEnough('\u{1F600}\u{1F600}\u{1F600}')).toBe(false)
    expect(pinIsLongEnough('\u{1F600}'.repeat(6))).toBe(true)
  })

  // One reading of the PIN for both the check and the room: what the check ignores, the room
  // ignores too, so the PIN that passed is the PIN the other devices meet in.
  it('the check and the room read the same PIN', async () => {
    expect(await deriveRoom('ABCD1234', '482\u200B193')).toBe(await deriveRoom('ABCD1234', '482193'))
    // The same letters typed on two keyboards (composed and decomposed) open the same room.
    expect(await deriveRoom('ABCD1234', 'caf\u00e9-pin')).toBe(await deriveRoom('ABCD1234', 'cafe\u0301-pin'))
  })

  // Characters that draw nothing or only steer text direction are not part of what a person reads
  // out: they neither count nor change the room. The joiners inside one emoji or letter stay.
  it('direction marks and blank fillers neither count nor change the room', async () => {
    for (const blank of ['\u200E', '\u200F', '\u202A', '\u3164', '\u2800', '\uFFA0', '\u115F', '\u1160']) {
      expect(pinIsLongEnough(blank.repeat(6)), JSON.stringify(blank)).toBe(false)
      expect(await deriveRoom('ABCD1234', `482${blank}193`)).toBe(await deriveRoom('ABCD1234', '482193'))
    }
  })

  // The room of a non-ASCII PIN, pinned by value: computed with node's own SHA-256 over
  // "konclave-room-v4\0ABCD1234\0" + the composed (NFC) PIN, not with the code under test. Any other
  // canonical form that changes these PINs (NFD, no composing, a different strip) goes red.
  it.each([
    ['caf\u00e9-pin', '0de5ed60f23ed6cceee4726f559f8670'],
    ['cafe\u0301-pin', '0de5ed60f23ed6cceee4726f559f8670'],
    ['e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301', 'e1a6f26cdaaaa147237d3faa966a8909'],
    // An invisible character between a letter and its accent leaves one composed letter, not two.
    ['e\u200B\u0301e\u0301e\u0301e\u0301e\u0301e\u0301', 'e1a6f26cdaaaa147237d3faa966a8909'],
  ])('a non-ASCII PIN %j has its pinned room', async (pin, want) => {
    expect(await deriveRoom('ABCD1234', pin)).toBe(want)
  })

  // A browser without Intl.Segmenter still opens the screen and still counts (by code point).
  it('still counts where the browser has no grapheme segmenter', () => {
    // Built when the module loads, a missing Segmenter would stop all of net.ts from loading.
    expect(codeOf('./net.ts')).not.toMatch(/^(const|let|var) \w+ = new Intl\.Segmenter/m)
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined })
    try {
      expect(pinIsLongEnough('123456')).toBe(true)
      expect(pinIsLongEnough('12345')).toBe(false)
      expect(pinIsLongEnough('\u{1F600}'.repeat(3))).toBe(false) // by code point, not UTF-16 unit
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('the PIN rule is written with escapes, not invisible characters', () => {
    expect(codeOf('./net.ts')).not.toMatch(/[\u00AD\u115F\u1160\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2800\u3164\uFEFF\uFFA0]/)
  })

  // ZWNJ shapes a word in some scripts (Persian, for one): it is part of what was typed and stays.
  it('a zero-width non-joiner stays in the PIN', async () => {
    expect(await deriveRoom('ABCD1234', 'mi\u200Cxyzw')).not.toBe(await deriveRoom('ABCD1234', 'mixyzw'))
  })

  // The PIN is read out on a call, so what sounds the same opens the same room: the full-width digits
  // an IME types are the digits of the same PIN (NFKC). Pinned by value: the room of the ASCII PIN
  // 482193, computed with node's SHA-256 outside the code under test.
  it('full-width digits open the room of the same digits', async () => {
    const fullWidth = '\uFF14\uFF18\uFF12\uFF11\uFF19\uFF13'
    expect(pinIsLongEnough(fullWidth)).toBe(true)
    expect(await deriveRoom('ABCD1234', fullWidth)).toBe('b65a06a5fee406812f7f148d32f6267f')
  })

  // A joiner or a combining mark that opens the PIN has nothing before it to join: it is not a
  // character a person reads out, so it neither counts nor changes the room.
  it('a leading joiner or mark neither counts nor changes the room', async () => {
    for (const lead of ['\u200D', '\u200C', '\u0301', '\u200D\u0301']) {
      expect(pinIsLongEnough(`${lead}12345`), JSON.stringify(lead)).toBe(false)
      expect(await deriveRoom('ABCD1234', `${lead}482193`), JSON.stringify(lead)).toBe(await deriveRoom('ABCD1234', '482193'))
    }
  })

  it('counts what a person sees, not code points', () => {
    expect(pinIsLongEnough('e\u0301'.repeat(3))).toBe(false)
    expect(pinIsLongEnough('e\u0301'.repeat(6))).toBe(true)
    expect(pinIsLongEnough('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'.repeat(3))).toBe(false)
  })

  it('no room is derived from a PIN shorter than the minimum', async () => {
    await expect(deriveRoom('ABCD1234', '4821')).rejects.toThrow()
    await expect(deriveRoom('ABCD1234', '48219')).rejects.toThrow()
    await expect(deriveRoom('ABCD1234', '482193')).resolves.toMatch(/^[0-9a-f]{32}$/)
  })

  // A form that tests the PIN on its own (`pin.trim()`) is a second copy of the rule, and the one
  // that drifts. Every PIN check in the creation screen asks pinIsLongEnough.
  it('the creation screen has no PIN check of its own', () => {
    const src = codeOf('./screens/NetVault.tsx')
    expect(src).not.toMatch(/pin\.trim\(\)/)
    // Every button that opens a room is held by the same check, not one of them.
    const opens = src.match(/void begin\(/g) ?? []
    const held = src.match(/disabled=\{[^}]*(?:pinIsLongEnough\(pin\)|createPinOk)[^}]*\}/g) ?? []
    expect(opens.length).toBeGreaterThan(0)
    expect(held.length).toBe(opens.length)
  })

  it('the copy no longer suggests a PIN of four digits', () => {
    for (const f of ['screens/NetVault.tsx', 'screens/CeremonyParts.tsx', 'docs/content.ts']) {
      const src = codeOf(`./${f}`)
      expect(src).not.toMatch(/4 to 6|4 a 6/)
      expect(src).not.toMatch(/\b4\b[^'`]{0,12}(digits|dígitos)/)
      expect(src).not.toMatch(/Math\.max\(4,/)
    }
  })

  // The hidden PIN is drawn as bullets; a screen reader must not read them out one by one.
  it('the hidden PIN is not read out as bullets', () => {
    const pe = (_pt: string, en: string) => en
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'konclave.test', origin: 'https://konclave.test', pathname: '/' })
    const html = renderToStaticMarkup(createElement(InviteCard, { code: '0123456789ABCDEFGHJKMNPQRS', pin: '482193', pe }))
    expect(html).toMatch(/<span class="cv-pin-value" aria-hidden="true">•+<\/span>/)
    // ...but it hears that a PIN is there and hidden, and the toggle names what it shows.
    expect(html).toMatch(/<span class="sr-only">hidden<\/span>/)
    expect(html).not.toMatch(/aria-pressed/)
    expect(html).toMatch(/<button[^>]*>show<span class="sr-only"> the room PIN<\/span><\/button>/)
  })
})

// The PIN slows down whoever holds the invite; with a PIN a person makes up, it does not keep them
// out. So the help does not promise that the invite alone cannot find the room.
describe('the PIN help, on what the PIN does', () => {
  it('does not promise that the invite alone cannot find the room', () => {
    const code = codeOf('screens/NetVault.tsx')
    expect(code).not.toMatch(/cannot find the room/)
    expect(code).not.toMatch(/não acha a sala/)
    // The own-PIN help says what a made-up PIN costs instead.
    expect(code).toMatch(/A PIN you make up is easier to guess than the one the app made/)
  })
})
