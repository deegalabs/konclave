import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeOf } from './source-scan'

// Every use of PassphraseField passes a non-empty label, and none sits inside a <label> (that would
// give the input two names). Scope: PassphraseField only - the raw password inputs elsewhere are a
// separate, known gap and are not covered here.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx$/.test(f) && !/\.test\./.test(f) ? [p] : []
  })
}
const root = fileURLToPath(new URL('.', import.meta.url))
const users = sources(root).map((p) => p.slice(root.length)).filter((p) => p !== 'components.tsx')
  .filter((p) => readFileSync(root + p, 'utf8').includes('<PassphraseField'))

// The pattern itself: a blank label and `aria-label=` must not count as a label.
const LABEL = /(?<![\w-])label=(\{[^}]*\S[^}]*\}|"[^"]*\S[^"]*")/

describe('every PassphraseField is labelled', () => {
  it('the label pattern rejects a blank label and aria-label', () => {
    expect(LABEL.test('<PassphraseField label=" " />')).toBe(false)
    expect(LABEL.test('<PassphraseField aria-label="x" />')).toBe(false)
    expect(LABEL.test('<PassphraseField label={t(\'k\')} />')).toBe(true)
    expect(LABEL.test('<PassphraseField label="Name" />')).toBe(true)
  })
  it('finds the known callers', () => {
    expect(users.sort()).toEqual(['screens/NetVault.tsx', 'screens/Settings.tsx'])
  })
  it('each tag has a non-empty label and no <label> ancestor', () => {
    let tags = 0
    for (const f of users) {
      const src = codeOf(f)
      for (const m of src.matchAll(/<PassphraseField\b[\s\S]*?\/>/g)) {
        tags++
        expect(m[0], `${f}: label=`).toMatch(LABEL)
        expect(m[0], `${f}: empty label`).not.toMatch(/\blabel=(""|\{''\}|\{""\})/)
      }
      // no <label ...> opened and not yet closed when a PassphraseField starts
      let depth = 0
      for (const m of src.matchAll(/<label\b|<\/label>|<PassphraseField\b/g)) {
        if (m[0] === '<label') depth++
        else if (m[0] === '</label>') depth--
        else expect(depth, `${f}: PassphraseField inside <label>`).toBe(0)
      }
    }
    expect(tags).toBe(6)
  })
})
