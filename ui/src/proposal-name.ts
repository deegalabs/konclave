// The name a proposal is shown under (#296), in ONE place. Every screen and the exported book used
// to write `p.memo || <kind label>` on its own, and a payroll on the web path, whose memo is always
// empty, had no name anywhere. A payroll now carries its own `title`, never its memo: on a single
// payment the memo is the on-chain memo.
//
// The title is display-only. It is not covered by the vote's signature (#567), so no copy may
// present it as something the members approved.

/** The longest title the coordinator stores, in characters (`orchestrator::helper::PAYROLL_TITLE_MAX_CHARS`). */
export const PAYROLL_TITLE_MAX = 120

/** A payroll's own title, else its memo (a payment's memo, or the local bridge's payroll description), else `fallback`. */
export function proposalName(p: { title?: string | null; memo?: string | null }, fallback: string): string {
  return p.title?.trim() || p.memo?.trim() || fallback
}

/** The direction marks, embeddings, overrides and isolates the coordinator refuses, as inclusive
 *  code point ranges. Read against `payroll_title` in `orchestrator/src/helper.rs` by a test. */
export const TITLE_BIDI_RANGES: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]

const refused = (c: string): boolean => {
  if (/\p{Cc}/u.test(c)) return true // Rust's char::is_control is the same Unicode category
  const cp = c.codePointAt(0) ?? 0
  return TITLE_BIDI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

/** What the coordinator would refuse in this title, checked the same way and in the same order:
 *  trimmed first, then the characters, then the length in characters (not UTF-16 units). */
export function titleProblem(title: string): 'long' | 'chars' | null {
  const chars = [...title.trim()]
  if (chars.some(refused)) return 'chars'
  return chars.length > PAYROLL_TITLE_MAX ? 'long' : null
}
