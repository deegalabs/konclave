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
