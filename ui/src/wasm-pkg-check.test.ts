import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The rule lives in the script, which the CI `wasm` job also runs on the package it builds from
// source. This file runs it on the COMMITTED package, and plants one defect per rule in a copy to
// show each check can fail.
import { checkWasmPkg, memoryFlags } from '../../scripts/check-wasm-pkg.mjs'

const PKG = fileURLToPath(new URL('./wasm-pkg', import.meta.url))
const GLUE = 'konclave_wasm.js'
const WASM = 'konclave_wasm_bg.wasm'

const dirs: string[] = []
function copy(): string {
  const d = mkdtempSync(join(tmpdir(), 'wasm-pkg-'))
  dirs.push(d)
  cpSync(PKG, d, { recursive: true })
  return d
}
function editGlue(d: string, f: (s: string) => string): void {
  const p = join(d, GLUE)
  writeFileSync(p, f(readFileSync(p, 'utf8')))
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('the signer WASM package can reach only what was reviewed', () => {
  it('the committed package holds', () => {
    expect(checkWasmPkg(PKG)).toEqual([])
  })

  it('an import whose body the glue changed is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace('const ret = Date.now();', 'const ret = Date.now(); globalThis.leak = 1;'))
    expect(checkWasmPkg(d).join('\n')).toMatch(/does something other than the reviewed body/)
  })

  it('a glue import the .wasm does not ask for is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace('const import0 = {\n        __proto__: null,', 'const import0 = {\n        __proto__: null,\n        __wbg_extra_0000000000000000: function() { return 1; },'))
    const out = checkWasmPkg(d).join('\n')
    expect(out).toMatch(/provides __wbg_extra_0000000000000000, which the .wasm does not import/)
    expect(out).toMatch(/__wbg_extra_0000000000000000 is not in the reviewed list/)
  })

  it('an import missing from the reviewed list is refused', () => {
    const allow = JSON.parse(readFileSync(fileURLToPath(new URL('../../scripts/wasm-imports.allowlist.json', import.meta.url)), 'utf8')).imports
    const name = Object.keys(allow).find((k) => k.startsWith('__wbg_now_'))!
    const { [name]: _gone, ...rest } = allow
    expect(checkWasmPkg(PKG, { allowlist: rest }).join('\n')).toMatch(new RegExp(`${name} is not in the reviewed list`))
  })

  it('an import statement in the glue (inline or module JS) is refused', () => {
    const d = copy()
    editGlue(d, (s) => `import { leak } from './snippets/x/inline0.js';\n${s}`)
    expect(checkWasmPkg(d).join('\n')).toMatch(/import statement/)
  })

  it('a side-effect import written with no space is refused', () => {
    const d = copy()
    editGlue(d, (s) => `import"./x.js";\n${s}`)
    expect(checkWasmPkg(d).join('\n')).toMatch(/import statement/)
  })

  it('a snippets directory is refused', () => {
    const d = copy()
    mkdirSync(join(d, 'snippets'))
    expect(checkWasmPkg(d).join('\n')).toMatch(/snippets/)
  })

  it.each(['XMLHttpRequest', 'WebSocket', 'sendBeacon', 'localStorage', 'Reflect', 'eval', 'cookie', 'WebTransport'])('the glue naming %s in an exported wrapper is refused', (api) => {
    const d = copy()
    editGlue(d, (s) => s.replace(/^export function /m, `export function unused() { return ${api}; }\nexport function `))
    expect(checkWasmPkg(d).join('\n')).toMatch(new RegExp(`exported wrapper names ${api}`))
  })

  it('a name in a comment is not a capability', () => {
    const d = copy()
    editGlue(d, (s) => s.replace(/^export function /m, '// a Worker would evaluate this\n/* WebSocket */\nexport function '))
    expect(checkWasmPkg(d)).toEqual([])
  })

  it('a changed helper the imports call is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace(/function handleError\(f, args\) \{\n/, 'function handleError(f, args) {\n    globalThis.leak = args;\n'))
    expect(checkWasmPkg(d).join('\n')).toMatch(/glue runtime handleError differs/)
  })

  it('a new top-level statement in the glue is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace('function getStringFromWasm0(', 'globalThis.leak = 1;\nfunction getStringFromWasm0('))
    expect(checkWasmPkg(d).join('\n')).toMatch(/not in the reviewed list: globalThis\.leak/)
  })

  it('a second fetch inside the loader is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace('module_or_path = fetch(module_or_path);', 'module_or_path = fetch(module_or_path); fetch("https://x");'))
    expect(checkWasmPkg(d).join('\n')).toMatch(/glue runtime __wbg_init differs/)
  })

  it('a decoy import object before the real one is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace('function getStringFromWasm0(', 'function decoy() {\n    const import0 = {\n        __proto__: null,\n    };\n}\nfunction getStringFromWasm0('))
    expect(checkWasmPkg(d).join('\n')).toMatch(/decoy/)
  })

  it('an import entry reassigned before the object is returned is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace(/(\n    \};\n    return \{)/, '\n    };\n    import0.leak = globalThis;\n    return {'))
    expect(checkWasmPkg(d).join('\n')).toMatch(/glue runtime __wbg_get_imports differs/)
  })

  it('an import entry swapped inside the loader is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace('const imports = __wbg_get_imports();', 'const imports = __wbg_get_imports(); imports.leak = 1;'))
    expect(checkWasmPkg(d).join('\n')).toMatch(/glue runtime __wbg_(init|load|get_imports)|initSync differs/)
  })

  it('a re-export from another module is refused', () => {
    const d = copy()
    editGlue(d, (s) => `${s}\nexport { x } from './extra.js';\n`)
    expect(checkWasmPkg(d).join('\n')).toMatch(/re-exports from another module/)
  })

  it.each(['x.constructor("return fetch")', 'window.open("https://x")', 'setTimeout("x")', 'navigator.userAgent'])('an exported wrapper using %s is refused', (code) => {
    const d = copy()
    editGlue(d, (s) => s.replace(/^export function /m, `export function unused(x) { return ${code}; }\nexport function `))
    expect(checkWasmPkg(d).length).toBeGreaterThan(0)
  })

  it.each([
    ['rebinds a helper', 'getStringFromWasm0 = (a, b) => ""; return 1;', /assigns to the runtime's getStringFromWasm0/],
    ['reaches a global by a computed name', 'return globalThis["fe" + "tch"];', /names globalThis/],
    ['reaches self by a computed name', 'return self["fe" + "tch"];', /names self/],
    ['replaces the random source', 'crypto.getRandomValues = (a) => a.fill(7); return 1;', /names crypto/],
  ])('an exported wrapper that %s is refused', (_what, code, why) => {
    const d = copy()
    editGlue(d, (s) => s.replace(/^export function /m, `export function unused() { ${code} }\nexport function `))
    expect(checkWasmPkg(d).join('\n')).toMatch(why)
  })

  it.each(['export*from"./x.js";', 'export{a}from"./x.js";', "export * from './x.js';"])('a re-export written as %s is refused', (line) => {
    const d = copy()
    editGlue(d, (s) => `${s}\n${line}\n`)
    expect(checkWasmPkg(d).join('\n')).toMatch(/re-exports from another module/)
  })

  it('another JS file in the package is refused', () => {
    const d = copy()
    writeFileSync(join(d, 'extra.js'), 'export const x = 1\n')
    expect(checkWasmPkg(d).join('\n')).toMatch(/another JS file: extra\.js/)
  })

  it('a reviewed runtime item that disappears is refused', () => {
    const reviewed = JSON.parse(readFileSync(fileURLToPath(new URL('../../scripts/wasm-imports.allowlist.json', import.meta.url)), 'utf8'))
    const runtime = { ...reviewed.runtime, ghostHelper: 'function ghostHelper() {}' }
    expect(checkWasmPkg(PKG, { runtime }).join('\n')).toMatch(/reviewed glue runtime ghostHelper is missing/)
  })

  it('a second producers section is refused', () => {
    const d = copy()
    const bytes = readFileSync(join(PKG, WASM))
    const name = Buffer.from('producers')
    const payload = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([0])])
    writeFileSync(join(d, WASM), Buffer.concat([bytes, Buffer.from([0, payload.length]), payload]))
    expect(checkWasmPkg(d).join('\n')).toMatch(/2 producers sections/)
  })

  it('an import from a module other than the glue is refused', () => {
    const d = copy()
    const bytes = readFileSync(join(PKG, WASM))
    const from = Buffer.from('./konclave_wasm_bg.js')
    const at = bytes.indexOf(from)
    expect(at).toBeGreaterThan(0)
    const other = Buffer.from(bytes)
    Buffer.from('./konclave_wasm_bg.jz').copy(other, at)
    writeFileSync(join(d, WASM), other)
    expect(checkWasmPkg(d).join('\n')).toMatch(/does not come from \.\/konclave_wasm_bg\.js/)
  })

  it('an import the glue does not provide is refused', () => {
    const d = copy()
    editGlue(d, (s) => s.replace(/\n {8}__wbg_now_[0-9a-f]{16}: function\(\) \{\n[^\n]*\n[^\n]*\n {8}\},/, ''))
    expect(checkWasmPkg(d).join('\n')).toMatch(/the \.wasm imports __wbg_now_[0-9a-f]{16}, which the glue does not provide/)
  })

  it('a fetch outside the loader is refused, however it is written, and the loader keeps its own', () => {
    for (const call of ['fetch("x")', '(0, fetch)("x")', 'globalThis.fetch.call(null, "x")']) {
      const d = copy()
      editGlue(d, (s) => s.replace(/^export function /m, `export function unused() { return ${call}; }\nexport function `))
      expect(checkWasmPkg(d).join('\n')).toMatch(/exported wrapper names fetch/)
    }
    // The committed glue has a fetch, in __wbg_init, and holds.
    expect(readFileSync(join(PKG, GLUE), 'utf8')).toMatch(/fetch\(module_or_path\)/)
  })

  it('a shared memory is refused', () => {
    const bytes = new Uint8Array(readFileSync(join(PKG, WASM)))
    expect(memoryFlags(bytes)).toEqual([expect.any(Number)])
    expect(memoryFlags(bytes)[0] & 0x02).toBe(0)
    const d = copy()
    writeFileSync(join(d, WASM), sharedMemoryVariant(bytes))
    // A valid module (shared with a maximum): only the shared-memory rule speaks.
    expect(checkWasmPkg(d)).toEqual(['the module memory is shared'])
  })

  it('a package built by another wasm-bindgen than Cargo.lock pins is refused', () => {
    const lock = '[[package]]\nname = "wasm-bindgen"\nversion = "0.2.999"\n'
    expect(checkWasmPkg(PKG, { cargoLock: lock }).join('\n')).toMatch(/built by wasm-bindgen 0\.2\.\d+ .*Cargo\.lock pins 0\.2\.999/)
  })
})

/** The module with its one memory made shared: flags 0x03 and a maximum equal to the minimum, the
 *  memory section's size grown by the bytes added. A valid module, so the rule itself is what refuses. */
function sharedMemoryVariant(bytes: Uint8Array): Uint8Array {
  const leb = (at: number): [number, number] => {
    let r = 0, s = 0, b: number
    do { b = bytes[at++]; r |= (b & 0x7f) << s; s += 7 } while (b & 0x80)
    return [r >>> 0, at]
  }
  const enc = (n: number): number[] => {
    const out: number[] = []
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b) } while (n)
    return out
  }
  let at = 8
  while (at < bytes.length) {
    const idAt = at
    const id = bytes[at++]
    const [size, body] = leb(at)
    if (id === 5) {
      const [count, flagsAt] = leb(body)
      if (count !== 1 || bytes[flagsAt] & 0x01) throw new Error('expected one memory with no maximum')
      const [min, afterMin] = leb(flagsAt + 1)
      const content = [...enc(count), 0x03, ...enc(min), ...enc(min), ...bytes.slice(afterMin, body + size)]
      return new Uint8Array([...bytes.slice(0, idAt), 5, ...enc(content.length), ...content, ...bytes.slice(body + size)])
    }
    at = body + size
  }
  throw new Error('no memory section')
}
