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
 * Class names with no rule, on purpose. Each carries WHY, because "known bad" is a list nobody ever
 * shrinks while "deliberately ruleless" is a claim someone can check.
 *
 * The seven this test found on its first run were audited: six are grouping hooks whose CHILDREN
 * carry the styling (`.foot`, `.who-name`, `.confirm`, `.hint.warn` all exist), or are styled
 * inline. One - `.mb-sm` - was a real utility that silently did nothing, and is now defined.
 *
 * Adding an entry should need a reason in the pull request. A wrapper that groups is fine; a class
 * you expected to DO something is what this test exists to catch.
 */
const KNOWN_UNSTYLED = new Set([
  'net-sign', // NetVault: wrapper around the signing block; children carry the styling
  'net-what', // NetVault: styled inline via `style={{...}}`
  'page-footer', // page.tsx: semantic hook beside `.foot`, which is what styles it
  'sign-err', // SigningPanel: groups `.hint.warn` / `.hint.err`, which do the work
  'sign-ok', // SigningPanel: groups `.confirm.ready`, which does the work
  'sign-seat-name', // SigningPanel: a span inheriting the row's type
  'sign-presence', // SigningPanel: wrapper around the seat list
  'sign-run', // SigningPanel: wrapper; `.sign-run-head` inside it is what is styled
  'spend', // charts: a role="group" container; the bars inside carry the styling
  'prev', // Docs pager: the MIRROR of `.next`, which needs a rule to push itself right.
  //         `.docs-pager` is space-between, so the default left alignment already is `.prev`.
])

describe('every class name used in the UI has a rule behind it', () => {
  it('no component reaches for a class the stylesheets do not define', () => {
    // Comments are stripped, because they are prose ABOUT css and not css. Without this, a class
    // mentioned in a comment counts as defined - which is how this very test first passed a
    // red-check: the comment explaining why `.mb-sm` had been missing was itself enough to satisfy
    // the search for `.mb-sm`. A check that its own documentation can satisfy is not a check.
    const css = walk(abs('src'), '.css')
      .map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '))
      .join('\n')
    expect(css.length, 'the stylesheets were found').toBeGreaterThan(1000)

    const offenders: string[] = []
    for (const file of walk(abs('src'), '.tsx')) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/className="([a-z0-9 _-]+)"/g)) {
        for (const cls of m[1]!.split(/\s+/).filter(Boolean)) {
          if (KNOWN_UNSTYLED.has(cls)) continue
          // A word boundary, not a substring. `css.includes('.mb-sm')` is satisfied by `.mb-sm-x`,
          // which made the check quietly permissive: a class passed whenever any LONGER name
          // happened to start with it. Caught by red-checking the test itself, which is the only
          // way that kind of hole shows up.
          if (!new RegExp(`\\.${cls}(?![\\w-])`).test(css)) {
            offenders.push(`${file.split('/src/')[1]}: .${cls}`)
          }
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
