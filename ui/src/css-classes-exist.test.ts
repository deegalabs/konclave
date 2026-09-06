import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// A class name with no rule behind it renders as nothing, and nothing is what you get: no error, no
// warning, no failing test. The element just looks unfinished, and only a human looking at the
// screen finds it.
//
// I did it twice in one day. #426's delete dialog shipped with `.unlock-lab` and `.unlock-in`, which
// do not exist, so the confirm field rendered raw with the browser's default focus ring. Hours later
// I reached for `.set-sec` and `.set-sec-title` in Settings, which also do not exist.
//
// This makes that class of mistake impossible to merge. It is deliberately conservative: it reads
// only literal `className="..."` strings, so anything computed is out of scope and there are no
// false positives to teach people to ignore.

const root = new URL('../', import.meta.url)
const abs = (p: string) => fileURLToPath(new URL(p, root))

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== 'wasm-pkg' && name !== 'node_modules') walk(p, ext, out)
    } else if (name.endsWith(ext)) out.push(p)
  }
  return out
}

/**
 * Classes that already had no rule when this test was written. They are listed rather than ignored
 * so the debt is visible and finite: each one is an element rendering unstyled somewhere today.
 * Deleting an entry is the fix; adding one should need a reason in the pull request.
 */
const KNOWN_UNSTYLED = new Set([
  'mb-sm',
  'net-sign',
  'net-what',
  'page-footer',
  'sign-err',
  'sign-ok',
  'sign-seat-name',
])

describe('every class name used in the UI has a rule behind it', () => {
  it('no component reaches for a class the stylesheets do not define', () => {
    const css = walk(abs('src'), '.css').map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(css.length, 'the stylesheets were found').toBeGreaterThan(1000)

    const offenders: string[] = []
    for (const file of walk(abs('src'), '.tsx')) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/className="([a-z0-9 _-]+)"/g)) {
        for (const cls of m[1]!.split(/\s+/).filter(Boolean)) {
          if (KNOWN_UNSTYLED.has(cls)) continue
          if (!css.includes('.' + cls)) offenders.push(`${file.split('/src/')[1]}: .${cls}`)
        }
      }
    }

    expect(
      [...new Set(offenders)].sort(),
      'these class names have no rule in any stylesheet, so the element renders unstyled and ' +
        'nothing fails. Add the rule, use an existing class, or if it is genuinely intended, add it ' +
        'to KNOWN_UNSTYLED with a reason. Offenders:',
    ).toEqual([])
  })
})
