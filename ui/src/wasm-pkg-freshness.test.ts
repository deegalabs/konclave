import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The committed `ui/src/wasm-pkg` is what the BROWSER runs. CI builds the wasm to a temp directory
// and never compares it with this one, so a Rust change can merge green and never reach production.
//
// That is not hypothetical. #430 (refuse a small-order X25519 key) merged on 2026-09-05 and the
// committed package still predated it: the fix existed in the repo and not in the app. Nothing
// failed, because nothing was looking.
//
// This looks. It is a cheap structural check, not a build: every `js_name` the Rust exports must be
// present in the committed typings. It cannot prove the WASM BYTES are current - only that no
// export is missing - but a missed regeneration almost always adds or renames one, and it turns
// "someone has to remember" into a red test.

const root = new URL('../../', import.meta.url)
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8')

describe('the committed wasm-pkg is not behind the Rust that produced it', () => {
  it('exports every js_name the crate declares', () => {
    const src = read('konclave-wasm/src/lib.rs')
    const declared = [...src.matchAll(/js_name\s*=\s*(\w+)/g)].map((m) => m[1]!)
    expect(declared.length, 'the crate declares some js_name exports').toBeGreaterThan(10)

    const dts = read('ui/src/wasm-pkg/konclave_wasm.d.ts')
    const missing = [...new Set(declared)].filter((n) => !dts.includes(n)).sort()

    expect(
      missing,
      `these exports exist in konclave-wasm/src/lib.rs and NOT in the committed package. ` +
        `Regenerate it: (cd konclave-wasm && wasm-pack build --target web --out-dir /tmp/pkg) ` +
        `then copy /tmp/pkg/* over ui/src/wasm-pkg/. Missing:`,
    ).toEqual([])
  })
})
