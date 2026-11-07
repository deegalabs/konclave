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

export type PassProblem = 'too-short' | 'guessable'

/** What a person reaches for, and what a cracker tries first. Short on purpose: the shape check below
 *  catches a single word with numbers whatever the word is, so this holds what that shape misses. */
const COMMON = [
  'password', 'passw0rd', 'senha', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'admin', 'welcome', 'letmein',
  'iloveyou', 'teamo', 'konclave', 'zcash', 'bitcoin', 'brasil', 'flamengo', 'corinthians', 'palmeiras',
  '123456789', '987654321', 'abcdefghijklmnopqrstuvwxyz', 'abcdefgh', 'abc123', 'a1b2c3d4', '1q2w3e4r', '1qaz2wsx',
]
const LEET: Record<string, string> = { '@': 'a', '4': 'a', '$': 's', '0': 'o', '1': 'l', '3': 'e', '5': 's', '7': 't' }
/** Only so a huge paste stays cheap: the checks below read this much. */
const MAX_READ = 256
/** From here the shape of the text is no longer judged (Daniel, 2026-10-31). */
const LONG_ENOUGH = 20
/** How a word is cased when a person types it: lower, capitalised, or all upper. */
const WORD_CASE = /^(?:\p{Lu}?\p{Ll}+|\p{Lu}+)$/u

/** Seasons, months and common first names and surnames (PT and EN), and a few of the most leaked words:
 *  read as words below 20 characters whatever their case, so `SUmmer2024!!` is not let through by its odd
 *  capitals. Short on purpose; it is not a dictionary. */
const NAMED = new Set([
  'spring', 'summer', 'autumn', 'fall', 'winter', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december', 'primavera', 'verao', 'outono', 'inverno', 'janeiro', 'fevereiro', 'marco',
  'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro', 'joao', 'maria', 'jose',
  'ana', 'pedro', 'paulo', 'lucas', 'gabriel', 'rafael', 'carlos', 'marcos', 'luiz', 'luis', 'felipe', 'bruno',
  'thiago', 'tiago', 'mateus', 'matheus', 'daniel', 'fernanda', 'juliana', 'camila', 'amanda', 'beatriz', 'larissa', 'leticia',
  'mariana', 'patricia', 'aline', 'vanessa', 'bianca', 'rodrigo', 'gustavo', 'eduardo', 'ricardo', 'fernando', 'antonio', 'francisco',
  'andre', 'diego', 'vitor', 'victor', 'john', 'james', 'robert', 'michael', 'william', 'david', 'richard', 'joseph',
  'thomas', 'charles', 'mary', 'jennifer', 'linda', 'elizabeth', 'susan', 'jessica', 'sarah', 'karen', 'emily', 'jack',
  'oliver', 'harry', 'george', 'silva', 'santos', 'oliveira', 'souza', 'sousa', 'lima', 'pereira', 'ferreira', 'costa',
  'rodrigues', 'almeida', 'nascimento', 'carvalho', 'gomes', 'martins', 'araujo', 'ribeiro', 'alves', 'smith', 'johnson', 'williams',
  'brown', 'jones', 'miller', 'davis', 'wilson', 'taylor', 'password', 'dragon', 'monkey', 'shadow', 'master', 'sunshine',
  'princess', 'football', 'baseball', 'welcome',
])

/** Is the lowercased core one listed word, two joined, or mostly made of listed tokens? */
function mostlyNamed(core: string): boolean {
  const c = core.toLowerCase()
  const letters = c.replace(/[^\p{L}]+/gu, '')
  const isNamed = (t: string) => NAMED.has(t) || [...Array(Math.max(0, t.length - 1)).keys()].some((i) => i >= 2 && NAMED.has(t.slice(0, i)) && NAMED.has(t.slice(i)))
  if (letters && isNamed(letters)) return true
  const named = c.split(/[^\p{L}]+/u).filter((t) => t && isNamed(t)).join('').length
  return named * 2 >= [...c].length
}

/** Could this run of letters be a word? Random letters mostly cannot: too short, no vowel, or a long
 *  run of consonants. Letters outside this alphabet get the benefit of the doubt towards a word. */
function isWordLike(run: string): boolean {
  if (run.length < 4) return false
  const w = run.toLowerCase()
  return !/^[a-z]+$/.test(w) || (/[aeiouy]/.test(w) && !/[^aeiouy]{4}/.test(w))
}

/** Does most of the text repeat at some period? Tolerant, so a character added at the end or a
 *  block cut short does not hide it. */
function repeatsABlock(text: string): boolean {
  const c = [...text]
  for (let period = 1; period <= Math.ceil(c.length * 0.6); period++) {
    let same = 0
    for (let i = period; i < c.length; i++) if (c[i] === c[i - period]) same++
    if (same >= (c.length - period) * 0.9 && c.length > period) return true
  }
  return false
}

/**
 * Why a passphrase may not be CHOSEN, or null if it may. The one rule: storage enforces it on every
 * writer that seals under a new passphrase, and the screens read it to say why. It never applies to
 * a passphrase a member already has.
 *
 * Under 12 characters is refused. From 20 characters, only a listed common password or repetition is:
 * at that length a person's word-and-year shape stops mattering as much as refusing what a password
 * manager generated. Between the two it also judges the shape people actually use, which the meter
 * cannot, since it counts character classes and `Konclave2026` looks rich to it: what the meter calls
 * weak, and text that is mostly fewer than four different words, whatever digits and symbols surround
 * them. It reads shape and knows only a short list of seasons, months and common names, so what it accepts is not proof of strength.
 */
export function newPassphraseProblem(s: string): PassProblem | null {
  // Close to what a person sees: composed, without format characters. Combining marks and blank-looking
  // letters still count, so someone determined can pad past 20; this guards against mistakes, not that.
  const visible = s.normalize('NFC').replace(/\p{Cf}/gu, '')
  const length = [...visible].length
  if (length < 12) return 'too-short'
  const kept = visible.slice(0, MAX_READ).normalize('NFD').replace(/\p{M}/gu, '')
  const plain = kept.toLowerCase()
  // Repetition: few distinct characters, little left once runs are collapsed, or a repeated block.
  if (new Set(plain).size < 5 || plain.replace(/(.)\1+/gu, '$1').length < Math.max(8, plain.length * 0.6) || repeatsABlock(plain)) return 'guessable'

  const core = [...kept.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')].map((c) => LEET[c] ?? c).join('')
  // Below 20, also with digits at the edges off and look-alikes read as letters. From 20 only as typed:
  // a listed word beside random text is not a listed password.
  for (const text of length >= LONG_ENOUGH ? [plain] : [plain, core.toLowerCase()]) {
    const rest = COMMON.reduce((t, word) => t.split(word).join(''), text)
    if (rest !== text && rest.length < 8) return 'guessable'
  }
  if (length >= LONG_ENOUGH) return null

  if (rawScore(s).score <= 1) return 'guessable'
  if (mostlyNamed(core)) return 'guessable'
  const tokens = core.split(/[^\p{L}]+|(?<=\p{Ll})(?=\p{Lu})/u).filter(Boolean)
  // Only a token cased the way a word is typed (all lower, capitalised, or all upper) counts: random
  // letters from a manager change case mid-run, and reading them as words refused one in five of them.
  const words = tokens.filter((t) => WORD_CASE.test(t) && isWordLike(t)).map((w) => w.toLowerCase())
  const inWords = words.join('').length
  if (new Set(words).size < 4 && inWords * 2 >= [...core].length) return 'guessable'
  return null
}

/**
 * Strength of a passphrase: 0 empty · 1 weak · 2 fair · 3 good · 4 strong. Estimates entropy from the
 * character-class pool and length, then scales it DOWN for low variety (few distinct characters),
 * repeated runs, and obvious sequences, so quantity alone never reads as strong.
 */
export function scorePassphrase(s: string): PassScore {
  const raw = rawScore(s)
  // One the rule refuses is weak: a meter saying "good" beside a refusal would contradict it.
  return raw.score > 1 && newPassphraseProblem(s) ? { ...raw, score: 1, label: 'weak' } : raw
}

function rawScore(s: string): PassScore {
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
 * How many passwords the generator draws before it gives up. About 4 draws in 1,000 are rated below
 * strong, so 32 in a row is below one chance in 10^70: the bound is there so the loop cannot run
 * forever, not because anyone should expect to reach it.
 */
const MAX_DRAWS = 32

/**
 * A strong password for a digital vault, and one the meter on the same screen rates strong.
 *
 * Twenty random characters sometimes contain a character three times in a row, or a run like
 * "defg", and `scorePassphrase` marks those down, so about 4 in 1,000 draws rate
 * below strong on the password the app chose. Those draws are discarded and drawn again. The meter is
 * not relaxed to make them pass. Discarding them costs well under a hundredth of a bit.
 *
 * `draw` is replaceable only so a test can reach the bound; the app always uses the default.
 */
export function generatePassphrase(draw: () => string = drawPassword): string {
  for (let i = 0; i < MAX_DRAWS; i++) {
    const candidate = draw()
    if (scorePassphrase(candidate).score === 4) return candidate
  }
  throw new Error(`No strong password after ${MAX_DRAWS} draws; the generator or the meter is broken`)
}

/**
 * One draw: 20 characters from every class (lower, upper, digit, symbol), with at least one of each
 * guaranteed, then shuffled. All entropy comes from crypto.getRandomValues; no wordlist to ship.
 * About 120 bits.
 */
function drawPassword(): string {
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
