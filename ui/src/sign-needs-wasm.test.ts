import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Anything that signs must first make sure the WASM is there.
//
// This cost a live vault an afternoon. `signGovernanceWrite` calls into WASM, and the vote path
// called it without loading the module. On a proposal screen nothing else had loaded it, so the call
// threw, a `catch {}` written to keep signing from ever blocking a vote swallowed it, the vote went
// out unsigned, and the helper answered "this vault requires a signed vote". True, and useless: it
// names the symptom on the server while the cause is an uninitialised module in the browser.
//
// #483 already learned this once, when five screens had hand-rolled initialisers and the export was
// the sixth path that needed one and had none. Signing was the seventh. The guard there says only
// `wasm-ready.ts` may LOAD the module; this one says every caller must ensure it is loaded.
//
// It got dangerous rather than merely wrong on the day #288 gated proposing and sending: while a
// vault is open an unsigned write is accepted, so the bug is invisible. It only bites once a vault
// has registered write keys, which is exactly when it matters most.

const SRC = new URL('.', import.meta.url).pathname

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'wasm-pkg' ? [] : sources(p)
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return []
    return [p]
  })
}

/** Modules that reach into WASM to sign. `device-key.ts` is the wrapper itself. */
const SIGNERS = ['signGovernanceWrite', 'writeProof']

describe('every governance signature ensures the WASM first', () => {
  const files = sources(SRC).filter((p) => !p.endsWith('device-key.ts'))

  it('somebody calls the signer, or this guard is watching nothing', () => {
    const callers = files.filter((p) => SIGNERS.some((s) => readFileSync(p, 'utf8').includes(`${s}(`)))
    expect(callers.length).toBeGreaterThan(0)
  })

  it('the module that signs also ensures the WASM', () => {
    // Only the module that builds the proof needs the ensure; screens go through it. So the rule is
    // narrow on purpose: whichever file calls `signGovernanceWrite` must also call `ensureWasm`.
    for (const p of files) {
      const src = readFileSync(p, 'utf8')
      if (!src.includes('signGovernanceWrite(')) continue
      expect(
        src.includes('ensureWasm('),
        `${p.slice(SRC.length)} calls signGovernanceWrite, which is a WASM call, without ` +
          'ensureWasm(). On a screen that loaded nothing it throws, and a swallowed throw here is ' +
          'an unsigned write that the helper refuses with a message about the server.',
      ).toBe(true)
    }
  })

  it('the signer does not swallow a failure without a trace', () => {
    // The catch is right - an unsigned write must not become an exception on a money screen - but a
    // silent one made a browser problem look like a server rule.
    const api = readFileSync(join(SRC, 'api.ts'), 'utf8')
    const fn = api.slice(api.indexOf('export async function writeProof'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toMatch(/catch\s*\(/)
    expect(body).toContain('console.error')
  })
})
