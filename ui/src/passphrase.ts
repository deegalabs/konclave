// Passphrase strength + generation (#221). A LIGHT, dependency-free estimator (no zxcvbn: keeps the
// bundle small). Strength is judged by COMPLEXITY, not length: a long run of one repeated character
// (e.g. "aaaaaaaa…") is weak, however long it is. The generator produces a strong password suitable
// for a digital vault, drawing on every character class. Both are pure enough to unit-test.

export type PassLabel = 'empty' | 'weak' | 'fair' | 'good' | 'strong'
export interface PassScore {
  score: 0 | 1 | 2 | 3 | 4
  label: PassLabel
  bits: number
}

/**
 * Strength of a passphrase: 0 empty · 1 weak · 2 fair · 3 good · 4 strong. Estimates entropy from the
 * character-class pool and length, then scales it DOWN for low variety (few distinct characters),
 * repeated runs, and obvious sequences, so quantity alone never reads as strong.
 */
export function scorePassphrase(s: string): PassScore {
  if (!s) return { score: 0, label: 'empty', bits: 0 }
  const len = s.length

  // Character-class pool actually used.
  const hasLower = /[a-z]/.test(s)
  const hasUpper = /[A-Z]/.test(s)
  const hasDigit = /[0-9]/.test(s)
  const hasSymbol = /[^a-zA-Z0-9]/.test(s)
  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length
  const pool = (hasLower ? 26 : 0) + (hasUpper ? 26 : 0) + (hasDigit ? 10 : 0) + (hasSymbol ? 34 : 0)

  let bits = len * Math.log2(pool || 1)

  // Complexity, not quantity. Scale entropy by how much NEW information the characters carry.
  const unique = new Set(s).size
  const variety = unique / len // 1 = every character distinct
  let factor = Math.min(1, variety * 1.15)
  if (/(.)\1\1/.test(s)) factor *= 0.4 // a character repeated 3+ times in a row
  if (/(0123|1234|2345|3456|4567|5678|6789|7890|abcd|bcde|cdef|defg|qwer|wert|erty|asdf|sdfg|zxcv)/i.test(s)) factor *= 0.6
  if (/^(?:password|senha|admin|welcome|qwerty|0000|1111)/i.test(s)) factor *= 0.3
  if (classes <= 1) factor *= 0.6 // a single class caps how strong it can be
  bits = Math.max(0, Math.round(bits * factor))

  // Buckets. A very short secret can never be more than weak, whatever its mix.
  let score: PassScore['score'] = bits < 36 ? 1 : bits < 60 ? 2 : bits < 88 ? 3 : 4
  if (len < 8) score = 1
  const label = (['empty', 'weak', 'fair', 'good', 'strong'] as const)[score]
  return { score, label, bits }
}

function randInt(max: number): number {
  // Rejection-sampled uniform integer in [0, max) from CSPRNG bytes.
  const a = new Uint32Array(1)
  const limit = Math.floor(0xffffffff / max) * max
  let v: number
  do {
    crypto.getRandomValues(a)
    v = a[0] ?? 0
  } while (v >= limit)
  return v % max
}

/**
 * A strong password for a digital vault: 20 characters drawn from every class (lower, upper, digit,
 * symbol), with at least one of each guaranteed, then shuffled. All entropy comes from
 * crypto.getRandomValues; no wordlist to ship. ~120+ bits, reads "strong" on the meter.
 */
export function generatePassphrase(): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const digit = '23456789'
  const symbol = '!@#$%^&*()-_=+?'
  const all = lower + upper + digit + symbol
  const LEN = 20

  const pick = (set: string): string => set[randInt(set.length)] ?? set[0] ?? '?'
  // Guarantee at least one character from each class, then fill the rest from the full pool.
  const chars: string[] = [pick(lower), pick(upper), pick(digit), pick(symbol)]
  while (chars.length < LEN) chars.push(pick(all))

  // Fisher-Yates shuffle so the guaranteed characters are not always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randInt(i + 1)
    const tmp = chars[i] as string
    chars[i] = chars[j] as string
    chars[j] = tmp
  }
  return chars.join('')
}
