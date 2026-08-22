// Passphrase strength + generation (#221). A LIGHT, dependency-free estimator (no zxcvbn: keeps the
// bundle small) — a rough entropy estimate from length × charset with penalties for the obvious weak
// patterns. The generator makes a pronounceable, memorable-ish passphrase with real entropy from
// crypto.getRandomValues (no wordlist to ship). Both are pure enough to unit-test.

export type PassLabel = 'empty' | 'weak' | 'fair' | 'good' | 'strong'
export interface PassScore {
  score: 0 | 1 | 2 | 3 | 4
  label: PassLabel
  bits: number
}

/** Rough strength of a passphrase: 0 empty · 1 weak · 2 fair · 3 good · 4 strong. */
export function scorePassphrase(s: string): PassScore {
  if (!s) return { score: 0, label: 'empty', bits: 0 }
  const len = s.length
  let charset = 0
  if (/[a-z]/.test(s)) charset += 26
  if (/[A-Z]/.test(s)) charset += 26
  if (/[0-9]/.test(s)) charset += 10
  if (/[^a-zA-Z0-9]/.test(s)) charset += 24
  let bits = len * Math.log2(charset || 1)
  // Penalties for obvious weakness.
  if (/(.)\1\1/.test(s)) bits -= 14 // a char repeated 3+ times in a row
  if (/^(?:[a-z]+|[A-Z]+|[0-9]+)$/.test(s) && len < 16) bits -= 12 // one class and short
  if (/^(?:1234|abcd|qwer|password|senha|0000)/i.test(s)) bits -= 20 // common start
  bits = Math.max(0, Math.round(bits))
  const score: PassScore['score'] = bits < 28 ? 1 : bits < 45 ? 2 : bits < 64 ? 3 : 4
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
 * A pronounceable, memorable passphrase with real entropy: four two-syllable words + a 2-digit
 * number, joined by '-' (e.g. "tavu-keby-3-lomi-daxo"). ~58 bits, reads "good/strong" on the meter.
 */
export function generatePassphrase(): string {
  const C = 'bcdfghjklmnpqrstvwxz'
  const V = 'aeiou'
  const word = () => {
    let w = ''
    for (let i = 0; i < 2; i++) w += (C[randInt(C.length)] ?? 'k') + (V[randInt(V.length)] ?? 'a')
    return w
  }
  const parts: string[] = Array.from({ length: 4 }, word)
  parts.splice(randInt(parts.length + 1), 0, String(randInt(90) + 10)) // a 2-digit number, random slot
  return parts.join('-')
}
