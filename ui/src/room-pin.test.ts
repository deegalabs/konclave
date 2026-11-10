import { describe, it, expect, vi, afterEach } from 'vitest'
import { codeOf } from './source-scan'
import { deriveRoom, generateRoomPin, formatRoomPin, dammCheckDigit, pinCheckFails, pinIsLongEnough, pinNeedsPlainDigits, pinLengthNote, PIN_MESSAGES } from './net'

afterEach(() => vi.restoreAllMocks())

// The creator's room PIN is made by the app: 12 random digits and a 13th that catches a mistyped
// digit. The rules live once, in net.ts: the generator, the check digit, the display grouping, and
// the refusal that deriveRoom and every form ask.
const swap = (s: string, i: number) => s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2)
const bump = (s: string, i: number) => s.slice(0, i) + String((Number(s[i]) + 1) % 10) + s.slice(i + 1)

describe('the generated room PIN', () => {
  it('is 13 digits, the last one a valid check digit', () => {
    for (let i = 0; i < 200; i++) {
      const p = generateRoomPin()
      expect(p).toMatch(/^\d{13}$/)
      expect(dammCheckDigit(p.slice(0, 12))).toBe(Number(p[12]))
      expect(pinCheckFails(p)).toBe(false)
      expect(pinIsLongEnough(p)).toBe(true)
    }
  })

  it('uses every digit and does not repeat', () => {
    const seen = new Set<string>()
    const all = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const p = generateRoomPin()
      for (const c of p.slice(0, 12)) all.add(c)
      if (i < 100) seen.add(p)
    }
    expect(all.size).toBe(10)
    expect(seen.size).toBe(100)
  })

  it('the check digit has known values', () => {
    expect(dammCheckDigit('572')).toBe(4)
    expect(dammCheckDigit('')).toBe(0)
  })

  it('a mistyped digit or two swapped neighbours fail the check', () => {
    for (let k = 0; k < 50; k++) {
      const p = generateRoomPin()
      for (let i = 0; i < 13; i++) expect(pinCheckFails(bump(p, i)), `${p} @${i}`).toBe(true)
      for (let i = 0; i < 12; i++) if (p[i] !== p[i + 1]) expect(pinCheckFails(swap(p, i)), `${p} swap ${i}`).toBe(true)
    }
  })

  it('is shown in groups of 4, 4, 4, 1', () => {
    expect(formatRoomPin('1234567890123')).toBe('1234 5678 9012 3')
  })
})

describe('the room PIN check', () => {
  it('spaced and unspaced digits are one room', async () => {
    const p = generateRoomPin()
    expect(await deriveRoom('ABCD1234', formatRoomPin(p))).toBe(await deriveRoom('ABCD1234', p))
    expect(await deriveRoom('ABCD1234', ` ${formatRoomPin(p)} `)).toBe(await deriveRoom('ABCD1234', p))
  })

  it('deriveRoom refuses a 13-digit PIN whose check digit is wrong', async () => {
    const p = bump(generateRoomPin(), 12)
    expect(pinCheckFails(formatRoomPin(p))).toBe(true)
    await expect(deriveRoom('ABCD1234', p)).rejects.toThrow()
  })

  it('only a PIN of exactly 13 digits is checked: shorter, longer and text PINs are the member’s own', () => {
    expect(pinCheckFails('123456')).toBe(false)
    expect(pinCheckFails('12345678901234')).toBe(false)
    expect(pinCheckFails('abcdefghijklm')).toBe(false)
  })
})

describe('one place for the PIN rules', () => {
  it('only net.ts draws random bytes for a PIN and checks the digit', () => {
    for (const f of ['./screens/NetVault.tsx', './screens/CeremonyParts.tsx']) {
      const src = codeOf(f)
      expect(src, f).not.toMatch(/getRandomValues/)
      expect(src, f).not.toMatch(/dammCheckDigit|DAMM|quasigroup/i)
      expect(src, f).not.toMatch(/\.length\s*[<>=]=*\s*(6|13)\b/)
    }
  })
})

describe('where the generated digits come from', () => {
  // Bytes of 250 and above are thrown away (250 is a multiple of 10, so the rest map to a digit
  // with no bias); the digits come only from the bytes that are kept, and from crypto.
  it('draws again after bytes that would bias a digit, and uses nothing else', () => {
    const known = Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 250)
    let calls = 0
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
      calls++
      buf.set(calls === 1 ? Array.from({ length: buf.length }, (_, i) => 250 + (i % 6)) : known)
      return buf
    }) as never)
    const p = generateRoomPin()
    expect(calls).toBe(2)
    expect(p.slice(0, 12)).toBe(known.slice(0, 12).map((b) => b % 10).join(''))
  })

  it('deriveRoom asks the same one function the forms ask', () => {
    expect(codeOf('./net.ts')).toMatch(/const problem = pinProblem\(p, false\)/)
  })

  it('net.ts has no Math.random', () => {
    expect(codeOf('./net.ts')).not.toMatch(/Math\.random/)
  })
})

describe('a PIN that looks like the digits but is not plain digits', () => {
  it('is refused when it is 13 decimal digits in another script, or split by hyphens or dots', async () => {
    const arabic = '\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660\u0661\u0662\u0663'
    for (const p of [arabic, '1234-5678-9012-3', '1234.5678.9012.3', '1234 5678-9012 3', '1234\u20105678\u20139012\u20143', '1234/5678/9012/3', '1234_5678_9012_3', '1234,5678,9012,3']) {
      expect(pinNeedsPlainDigits(p), p).toBe(true)
      await expect(deriveRoom('ABCD1234', p)).rejects.toThrow()
    }
  })

  it('is not asked of plain digits, of other lengths or of text', () => {
    for (const p of ['1234 5678 9012 3', '1234567890123', '123-456', 'blue heron', '1234-5678-9012-34']) {
      expect(pinNeedsPlainDigits(p), p).toBe(false)
    }
  })

  it('has its own words', () => {
    expect(PIN_MESSAGES.digits).toEqual({ en: 'Type only the digits of the PIN.', pt: 'Digite só os dígitos do PIN.' })
    expect(PIN_MESSAGES.own13.en).toBe('A PIN of 13 digits must end in its check digit. Choose another length, or use the PIN the app made.')
    expect(PIN_MESSAGES.own13.pt).toBe('Um PIN de 13 dígitos precisa terminar no dígito de conferência. Escolha outro tamanho, ou use o PIN que o app gerou.')
  })
})

describe('a PIN of digits that is close to 13 long', () => {
  it('says how many digits it has, from 10 to 12 and from 14 to 16', () => {
    expect(pinLengthNote('1234 5678 90')).toBe(10)
    expect(pinLengthNote('123456789012')).toBe(12)
    expect(pinLengthNote('12345678901234')).toBe(14)
    expect(pinLengthNote('1234567890123456')).toBe(16)
  })

  it('stays quiet for 13, for fewer than 10, for more than 16 and for text', () => {
    for (const p of ['1234567890123', '123456789', '12345678901234567', 'blue heron 12', '']) expect(pinLengthNote(p), p).toBeNull()
  })
})
