import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// The committed WASM must know every write action, and this is the only check that can see it.
//
// `wasm-pkg-freshness.test.ts` compares the EXPORT NAMES in the committed `.d.ts` against the
// `js_name` attributes in the Rust. It says so itself: it "cannot prove the WASM BYTES are current -
// only that no export is missing." A change INSIDE a function body merges green against a stale
// binary, and that is precisely what this change was: `sign_write` gained two arms in a match, no
// export changed, and the committed `.wasm` still held only the old three.
//
// The failure would have been silent in the worst way. The UI would ask for a `propose` signature,
// the stale WASM would answer `unknown write action`, `writeProof` would swallow it and return
// undefined by design, and the write would go UNSIGNED - the exact hole this work closes, reopened
// by a build step nobody ran, on a path that keeps working right up until a vault registers a key.
//
// Verified before it was trusted: the previously committed binary contained `approve` and not
// `propose`, and the rebuilt one contains all five.

const wasm = readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url))
const rust = readFileSync(new URL('../../konclave-seal/src/lib.rs', import.meta.url), 'utf8')

/** The action tags, read from the crate that defines them - never a list retyped here. */
function canonicalTags(): string[] {
  const body = rust.slice(rust.indexOf('pub fn tag(self)'))
  return [...body.matchAll(/=>\s*"([a-z]+)"/g)].map((m) => m[1]!)
}

describe('the committed WASM and the write actions', () => {
  const tags = canonicalTags()

  it('reads the tags from konclave-seal, and finds some', () => {
    expect(tags.length).toBeGreaterThanOrEqual(3)
    expect(tags).toContain('approve')
  })

  it.each(canonicalTags())('the committed binary knows %s', (tag) => {
    expect(
      wasm.includes(Buffer.from(tag)),
      `konclave-seal defines the write action "${tag}" and the committed wasm-pkg does not contain ` +
        'it, so this device cannot sign that action: the WASM answers "unknown write action", the ' +
        'caller falls back to unsigned, and the write is refused only once a vault has write keys. ' +
        'Rebuild: wasm-pack build --target web --out-dir ../ui/src/wasm-pkg',
    ).toBe(true)
  })
})
