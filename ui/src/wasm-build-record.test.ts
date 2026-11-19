import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The committed browser module against its record, without Rust (#1065). CI rebuilds the module from
// source and compares (scripts/build-wasm.mjs --check); this catches the same drift locally, and
// shows that each comparison the script makes can fail.
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { BEGIN, END, SOURCE_INPUTS, buildEnv, cargoConfigs, compare, configChangesBuild, refusals, outIsSafe, packageFiles, reachableLock, readRecord, sourceDigest, withRecord, workspaceSettings } from '../../scripts/build-wasm.mjs'

type Files = Record<string, { sha256: string; bytes: number }>
type WasmRecord = { wasm_pack?: string; source_digest?: string; files: Files }

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PKG = join(ROOT, 'ui/src/wasm-pkg')
const LOCK = readFileSync(join(ROOT, 'engine/versions.lock'), 'utf8')
const REGENERATE = 'Regenerate with `node scripts/build-wasm.mjs` and commit the package and engine/versions.lock.'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'wasm-record-')); dirs.push(d); return d }

/** The committed state compared with itself as the build: what the vitest can see without Rust. */
const problemsOf = (committed: Files, record: WasmRecord | null, source: string): string[] =>
  compare({ built: committed, committed, record, source })

describe('the committed browser module is the one its record names', () => {
  const record = readRecord(LOCK) as WasmRecord

  it('engine/versions.lock records the package, with the wasm-pack pin', () => {
    expect(record, `engine/versions.lock has no wasm record. ${REGENERATE}`).not.toBeNull()
    expect(record.wasm_pack).toMatch(/^\d+\.\d+\.\d+$/)
    expect(Object.keys(record.files)).toContain('konclave_wasm_bg.wasm')
  })

  it('every committed file is the recorded one, and the module was built from these sources', () => {
    expect(problemsOf(packageFiles(PKG), record, sourceDigest(ROOT)), REGENERATE).toEqual([])
  })
})

describe('each comparison can fail', () => {
  const record = readRecord(LOCK) as WasmRecord
  const committed = packageFiles(PKG) as Files
  const source = sourceDigest(ROOT)

  it('a module that is not the recorded one', () => {
    const changed = { ...committed, 'konclave_wasm_bg.wasm': { sha256: '00'.repeat(32), bytes: 1 } }
    expect(problemsOf(changed, record, source).join('\n')).toMatch(/konclave_wasm_bg\.wasm: the committed file .* is not the one engine\/versions\.lock records/)
  })

  it('a file the record does not name, and a recorded file that is missing', () => {
    const extra = { ...committed, 'snippet.js': { sha256: 'ab'.repeat(32), bytes: 3 } }
    expect(problemsOf(extra, record, source).join('\n')).toMatch(/snippet\.js: the committed file .* is not the one/)
    const { ['package.json']: _gone, ...missing } = committed
    expect(problemsOf(missing, record, source).join('\n')).toMatch(/package\.json: the committed file \(absent\)/)
  })

  it('a recorded size that is not the file\'s', () => {
    const wasm = record.files['konclave_wasm_bg.wasm']!
    const wrong = { ...record, files: { ...record.files, 'konclave_wasm_bg.wasm': { ...wasm, bytes: wasm.bytes + 1 } } }
    expect(problemsOf(committed, wrong, source).join('\n')).toMatch(/records \d+ bytes, the file has \d+/)
  })

  it('a source change without a regeneration', () => {
    expect(problemsOf(committed, record, 'ff'.repeat(32)).join('\n')).toMatch(/sources changed since the package was built/)
  })

  it('no record at all', () => {
    expect(problemsOf(committed, null, source).join('\n')).toMatch(/has no wasm record/)
  })

  it('a build that differs from the committed package (what CI compares)', () => {
    const built = { ...committed, 'konclave_wasm_bg.wasm': { sha256: 'cd'.repeat(32), bytes: 1 } }
    expect(compare({ built, committed, record, source }).join('\n')).toMatch(/konclave_wasm_bg\.wasm: the committed file .* is not what this source builds/)
  })
})

describe('the source digest covers what the module is built from, and only that', () => {
  /** A copy of the inputs, plus a test file that is not an input. */
  function copyInputs(): string {
    const d = scratch()
    for (const p of [...(SOURCE_INPUTS as string[]), 'Cargo.toml', 'Cargo.lock', 'konclave-wasm/README.md']) {
      mkdirSync(dirname(join(d, p)), { recursive: true })
      cpSync(join(ROOT, p), join(d, p), { recursive: true })
    }
    mkdirSync(join(d, 'konclave-seal/tests'), { recursive: true })
    writeFileSync(join(d, 'konclave-seal/tests/t.rs'), '// a test\n')
    return d
  }

  it('the copy digests like the tree', () => {
    expect(sourceDigest(copyInputs())).toBe(sourceDigest(ROOT))
  })

  it('changes with a line of konclave-seal, the toolchain pin, or the README wasm-pack copies', () => {
    for (const f of ['konclave-seal/src/lib.rs', 'konclave-wasm/rust-toolchain.toml', 'konclave-wasm/README.md']) {
      const d = copyInputs()
      writeFileSync(join(d, f), readFileSync(join(d, f), 'utf8') + '\n')
      expect(sourceDigest(d), f).not.toBe(sourceDigest(ROOT))
    }
  })

  it('changes with a LICENSE at the crate root, which wasm-pack would copy into the package', () => {
    const d = copyInputs()
    writeFileSync(join(d, 'konclave-wasm/LICENSE-MIT'), 'x')
    expect(sourceDigest(d)).not.toBe(sourceDigest(ROOT))
  })

  it('does not change with a lock entry or a workspace member the module does not reach', () => {
    const d = copyInputs()
    const lock = readFileSync(join(d, 'Cargo.lock'), 'utf8')
    writeFileSync(join(d, 'Cargo.lock'), `${lock}\n[[package]]\nname = "only-the-desktop-uses-this"\nversion = "1.0.0"\n`)
    const manifest = readFileSync(join(d, 'Cargo.toml'), 'utf8')
    writeFileSync(join(d, 'Cargo.toml'), manifest.replace('members = [', 'members = [\n  "a-new-member",'))
    expect(sourceDigest(d)).toBe(sourceDigest(ROOT))
  })

  it('changes with a reachable lock entry and with the resolver', () => {
    const lock = readFileSync(join(ROOT, 'Cargo.lock'), 'utf8')
    const reach = reachableLock(lock) as string
    expect(reach).toContain('name = "konclave-seal"')
    expect(reach).toContain('name = "orchard"')
    expect(reach).not.toContain('name = "tauri"')
    const d = copyInputs()
    writeFileSync(join(d, 'Cargo.lock'), lock.replace(/(name = "orchard"\nversion = ")([^"]+)"/, '$1$2-changed"'))
    expect(sourceDigest(d)).not.toBe(sourceDigest(ROOT))
    expect(workspaceSettings('[workspace]\nresolver = "2"\nmembers = [\n  "a",\n]\n# note\n')).toBe('[workspace]\nresolver = "2"')
    expect(workspaceSettings('[workspace]\nmembers = ["a"]\nexclude = [\n  "b",\n]\n')).toBe('[workspace]\nexclude = [\n  "b",\n]')
  })

  it('changes with a new source file, and not with a test file', () => {
    const added = copyInputs()
    writeFileSync(join(added, 'konclave-wasm/src/new.rs'), '')
    expect(sourceDigest(added)).not.toBe(sourceDigest(ROOT))
    const tests = copyInputs()
    writeFileSync(join(tests, 'konclave-seal/tests/t.rs'), '// another test\n')
    expect(sourceDigest(tests)).toBe(sourceDigest(ROOT))
  })
})

describe('the record in the lock', () => {
  it('is rewritten in place, keeping the rest of the lock and the hand-set pin', () => {
    const r = readRecord(LOCK) as WasmRecord
    const next = { ...r, source_digest: '12'.repeat(32) }
    const out = withRecord(LOCK, next) as string
    expect(readRecord(out)).toEqual(next)
    expect(out.slice(0, out.indexOf(BEGIN))).toBe(LOCK.slice(0, LOCK.indexOf(BEGIN)))
    expect(out.slice(out.indexOf(END))).toBe(LOCK.slice(LOCK.indexOf(END)))
  })

  it('refuses markers that are not one BEGIN followed by one END', () => {
    expect(() => readRecord(`${END}\n${BEGIN}\n`)).toThrow(/markers/)
    expect(() => readRecord(`${BEGIN}\n${BEGIN}\n${END}\n`)).toThrow(/markers/)
    expect(() => readRecord(`${BEGIN}\n[wasm]\n`)).toThrow(/markers/)
  })

  it('refuses a file entry without its digest or size', () => {
    expect(() => readRecord(`${BEGIN}\n[wasm]\nwasm_pack = "0.13.1"\n[[wasm_file]]\nname = "x"\n${END}\n`)).toThrow(/lacks name, sha256 or bytes/)
  })
})

describe('one recipe builds the module', () => {
  // A second recipe (a bare `wasm-pack build` in a workflow or a regenerate hint) builds without the
  // pinned compiler or the path remap, and its bytes differ from the committed package's.
  it('nothing outside scripts/build-wasm.mjs tells anyone to run wasm-pack build into the app', () => {
    const places = [
      ...readdirSync(join(ROOT, '.github/workflows')).map((f) => `.github/workflows/${f}`),
      ...readdirSync(join(ROOT, 'ui/src')).filter((f) => f.endsWith('.ts') && f !== 'wasm-build-record.test.ts').map((f) => `ui/src/${f}`),
    ]
    const offenders = places.filter((p) => /wasm-pack build/.test(readFileSync(join(ROOT, p), 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('the build cannot be steered by its environment or write outside a package', () => {
  it('drops what picks another compiler or changes its flags, and remaps paths as one argument each', () => {
    const env = buildEnv({ PATH: '/bin', RUSTC: '/x/rustc', RUSTC_WRAPPER: 'sccache', RUSTUP_TOOLCHAIN: '1.99.1', RUSTFLAGS: '-Copt-level=1', CARGO_INCREMENTAL: '1', RUSTC_BOOTSTRAP: '1', CARGO_UNSTABLE_X: 'y',
      CARGO_PROFILE_RELEASE_OPT_LEVEL: '1', CARGO_BUILD_TARGET: 'x', CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: '-g', HOME: '/h' }, '/my home/.cargo', '/r e p o') as Record<string, string>
    expect(Object.keys(env).sort()).toEqual(['CARGO_ENCODED_RUSTFLAGS', 'HOME', 'PATH'])
    expect(env.CARGO_ENCODED_RUSTFLAGS!.split('\x1f')).toEqual(['--remap-path-prefix=/my home/.cargo=/cargo', '--remap-path-prefix=/r e p o=/src'])
  })

  it('refuses a cargo config that can change the build, and accepts one that only reaches the network', () => {
    for (const c of ['[build]\njobs = 2', '[profile.release]\nopt-level = 1', '[target.wasm32-unknown-unknown]\nlinker = "x"',
      '[unstable]\nx = 1', '[patch.crates-io]\norchard = { path = "x" }', '[source.crates-io]\nreplace-with = "v"', '[env]\nX = "1"',
      'rustc-wrapper = "sccache"', '[net]\nretry = 2\n[build]\nrustc = "x"']) {
      expect(configChangesBuild(c), c).toBe(true)
    }
    expect(configChangesBuild('# mine\n[net]\ngit-fetch-with-cli = true\n[registries.x]\nindex = "y"\n[alias]\nb = "build"\n')).toBe(false)
  })

  it('refuses a build whose cargo home config or PATH would change it, and names why', () => {
    const home = scratch(); const crate = scratch(); const bin = scratch()
    expect(refusals({ PATH: bin }, crate, home)).toEqual([])
    writeFileSync(join(home, 'config.toml'), '[build]\nrustflags = ["-g"]\n')
    writeFileSync(join(bin, 'wasm-opt.exe'), '')
    const why = (refusals({ Path: bin }, crate, home) as string[]).join('\n')
    expect(why).toMatch(/config\.toml has settings that can change/)
    expect(why).toMatch(/a wasm-opt is on the PATH/)
  })

  it('reads every cargo config up to the filesystem root, and the cargo home\'s', () => {
    const list = cargoConfigs('/a/b/c', '/h/.cargo') as string[]
    for (const p of ['/h/.cargo/config.toml', '/a/b/c/.cargo/config.toml', '/a/b/.cargo/config.toml', '/a/.cargo/config', '/.cargo/config.toml']) expect(list).toContain(p)
  })

  it('writes only into an empty directory or a package, never over the repository', () => {
    const root = scratch()
    expect(outIsSafe(root, root)).toBe(false)
    expect(outIsSafe(dirname(root), root)).toBe(false)
    expect(outIsSafe(join(root, 'ui/src/wasm-pkg'), root)).toBe(false)
    expect(outIsSafe(join(root, 'new'), root)).toBe(true)
    const pkg = join(root, 'pkg'); mkdirSync(pkg)
    writeFileSync(join(pkg, 'konclave_wasm_bg.wasm'), ''); writeFileSync(join(pkg, 'package.json'), '')
    expect(outIsSafe(pkg, root)).toBe(true)
    writeFileSync(join(pkg, 'notes.txt'), '')
    expect(outIsSafe(pkg, root)).toBe(false)
  })

  it('digests the bytes of each package file, not its name or size', () => {
    const a = scratch()
    writeFileSync(join(a, 'konclave_wasm_bg.wasm'), 'abc')
    expect((packageFiles(a) as Files)['konclave_wasm_bg.wasm']).toEqual({ sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', bytes: 3 })
    writeFileSync(join(a, 'konclave_wasm_bg.wasm'), 'abd')
    expect((packageFiles(a) as Files)['konclave_wasm_bg.wasm']!.sha256).not.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
