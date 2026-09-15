import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// #483. `init(wasmUrl)` was awaited in exactly ONE place, so every WASM call in the product worked
// only because the background signer happened to have run first. #481 gave the export a reason to
// touch WASM on a screen the signer never visits, and it failed with `Cannot read properties of
// undefined (reading '__wbindgen_malloc')` - a message that says nothing about initialisation to
// whoever hits it.
//
// The fix is `ensureWasm()`, idempotent and shared. These pin the two things that make it work.

const SRC = new URL('.', import.meta.url).pathname

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { sources(p, out); continue }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('the WASM is initialised in one place', () => {
  it('only wasm-ready.ts calls init', () => {
    // A second `init(...)` is a second load and a second answer to "is it ready yet". The point of
    // `ensureWasm` is that the question has one answer for the whole app.
    const offenders = sources(SRC)
      .filter((p) => !p.endsWith('wasm-ready.ts'))
      .filter((p) => {
        const src = readFileSync(p, 'utf8')
        // A default import of the wasm module IS the initialiser; named imports are the functions.
        return /^import\s+init\s+from\s+['"].*wasm-pkg/m.test(src)
      })
      .map((p) => relative(SRC, p))

    expect(
      offenders,
      `these load the WASM themselves instead of awaiting ensureWasm(): ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('and the one call that exists uses the supported signature', () => {
    // wasm-bindgen deprecated the positional form. The glue still honours it and warns every single
    // load ("using deprecated parameters for the initialization function; pass a single object
    // instead"), so the warning reached the console of everyone using the product - sitting next to
    // the real diagnostics, which is how a warning that means something gets missed. Pinned here
    // because the generated glue is REGENERATED on every wasm build: nothing else would notice the
    // day it stops accepting the old form, and the failure then is a blank screen, not a warning.
    // Comments are stripped FIRST. The file explains what was replaced, so it necessarily contains
    // the deprecated form as prose - and a guard satisfied (or broken) by the comment beside it
    // measures nothing. This repo has hit that both ways: a className test passed on its own comment.
    const code = readFileSync(join(SRC, 'wasm-ready.ts'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

    expect(code, 'init must be passed an object').toMatch(/init\(\s*\{\s*module_or_path:/)
    expect(/init\(\s*wasmUrl\s*\)/.test(code), 'the deprecated positional form is back').toBe(false)
  })

  it('and nothing else reaches for the raw .wasm url', () => {
    // The url import is the other half of a hand-rolled init. Keeping it in one file is what makes
    // the rule above checkable at all.
    const offenders = sources(SRC)
      .filter((p) => !p.endsWith('wasm-ready.ts'))
      .filter((p) => /konclave_wasm_bg\.wasm\?url/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(SRC, p))

    expect(offenders, `these import the wasm url directly: ${offenders.join(', ')}`).toEqual([])
  })
})
