import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The two signers are checked against golden vectors that nothing kept equal (#365).
//
// EXTRACT and INJECT exist twice on purpose: natively in `konclave-signer` and in the browser in
// `konclave-wasm`, which re-derives the ZIP-244 sighash by hand. Two independent implementations
// checked against one vector is the right design for a byte-exact bridge across two runtimes, and
// its whole value rests on the vector genuinely being ONE. It is not: each crate `include_bytes!`s
// its own copy under `tests/vectors/`, and the sighash both pin is a literal typed in each crate.
// Until this file, the copies were equal by coincidence and by whoever last remembered to copy.
//
// This test runs in the UI step only because that step already runs on every PR; it reads the two
// crates as files and builds nothing. It does not judge which side is right - only that they agree.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SIGNER = join(REPO, 'konclave-signer')
const WASM = join(REPO, 'konclave-wasm')

/** Every `.rs` file under `dir`, recursively. */
function rustSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return rustSources(p)
    return name.endsWith('.rs') ? [p] : []
  })
}

/** The vector file names a crate's sources `include_bytes!` from `../tests/vectors/`. */
function vectorsReadBy(crate: string): string[] {
  const names = new Set<string>()
  for (const file of rustSources(join(crate, 'src'))) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/include_bytes!\(\s*"\.\.\/tests\/vectors\/([^"]+)"\s*\)/g)) {
      if (m[1] !== undefined) names.add(m[1])
    }
  }
  return [...names].sort()
}

/** The single capture of `re` in `src`; refuses zero or several, so a rename cannot pass vacuously. */
function only(src: string, re: RegExp, what: string): string {
  const hits = [...src.matchAll(re)]
  const hit = hits.length === 1 ? hits[0]?.[1] : undefined
  if (hit === undefined) throw new Error(`${what}: expected exactly one match, found ${hits.length}`)
  return hit
}

describe('the golden vectors the two signers are checked against', () => {
  it('every vector konclave-signer reads exists byte-identical in konclave-wasm', () => {
    const read = vectorsReadBy(SIGNER)
    // Not vacuous: the signer's C6 tests read the Ironwood single-spend triple at the very least.
    expect(read).toContain('ironwood_single_spend.proven.pczt')
    expect(read).toContain('ironwood_single_spend.signed.pczt')
    expect(read).toContain('ironwood_single_spend.sig0.raw')

    const missing = read.filter((n) => !existsSync(join(WASM, 'tests/vectors', n)))
    expect(missing, 'vectors konclave-signer reads that konclave-wasm does not carry').toEqual([])

    const differ = read.filter((n) => {
      const a = readFileSync(join(SIGNER, 'tests/vectors', n))
      const b = readFileSync(join(WASM, 'tests/vectors', n))
      return !a.equals(b)
    })
    expect(differ, 'vectors whose two copies are no longer byte-identical').toEqual([])
  })

  it('both crates pin the same Ironwood sighash literal, for the same vector', () => {
    const signer = readFileSync(join(SIGNER, 'src/main.rs'), 'utf8')
    const wasm = readFileSync(join(WASM, 'src/lib.rs'), 'utf8')

    // konclave-signer: the literal `extract_ironwood_sighash_and_randomizers` asserts for
    // `shielded_sighash(&parse(IW_PROVEN))`.
    const signerHex = only(
      signer,
      /fn extract_ironwood_sighash_and_randomizers\(\)\s*\{\s*let pczt = parse\(IW_PROVEN\);\s*assert_eq!\(\s*hex::encode\(shielded_sighash\(&pczt\)\.unwrap\(\)\),\s*"([0-9a-f]{64})"/g,
      'konclave-signer extract sighash literal',
    )
    // konclave-wasm: the `IW_SIGHASH` constant its parity tests sign and inject against.
    const wasmHex = only(
      wasm,
      /const IW_SIGHASH: \[u8; 32\] =\s*hex_literal\("([0-9a-f]{64})"\)/g,
      'konclave-wasm IW_SIGHASH literal',
    )

    // And both literals are about the same file: each crate's `IW_PROVEN`.
    const vectorRe = /const IW_PROVEN: &\[u8\] =\s*include_bytes!\("\.\.\/tests\/vectors\/([^"]+)"\)/g
    const signerVector = only(signer, vectorRe, 'konclave-signer IW_PROVEN')
    const wasmVector = only(wasm, vectorRe, 'konclave-wasm IW_PROVEN')
    expect(wasmVector).toBe(signerVector)

    expect(wasmHex, 'konclave-wasm IW_SIGHASH vs konclave-signer extract literal').toBe(signerHex)
  })
})
