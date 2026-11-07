import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The committed `ui/src/wasm-pkg` is what the BROWSER runs. The CI job `wasm` rebuilds it with
// scripts/build-wasm-pkg.sh and compares it byte for byte; this test is the quick, local half of the same
// question (is every exported function in the committed declarations?).
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
        `Regenerate it: scripts/build-wasm-pkg.sh --install (the one recipe CI also uses). Missing:`,
    ).toEqual([])
  })
})
