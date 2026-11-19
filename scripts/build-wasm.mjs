#!/usr/bin/env node
// The one recipe for the browser module (`ui/src/wasm-pkg`), used to regenerate it and by CI to check
// it. The committed package is what the browser runs; until this, CI built the module and threw the
// result away, so a Rust fix could merge green and never reach the app (#430 did, #1065).
//
// A build of the same source gives the same bytes on any machine when these inputs are fixed:
//   - the compiler, by `konclave-wasm/rust-toolchain.toml` (checked below, not trusted; the variables
//     that would pick another compiler or change its flags are removed from the build's environment);
//   - wasm-pack, by the `wasm_pack` pin in the record below (checked below), and through it the
//     wasm-bindgen CLI (the version Cargo.lock pins) and wasm-opt: wasm-pack 0.13.1 downloads binaryen
//     version_117, but uses a `wasm-opt` found on the PATH first, so the build refuses to run while
//     one is there. Both downloads are pinned by version, not by checksum;
//   - the dependency versions, by `--locked`;
//   - the paths the compiler embeds (panic locations name every crate's source file), by remapping
//     the cargo home and the repository to fixed prefixes.
// A cargo config in the cargo home that sets flags or profiles is refused for the same reason.
// Proven on 2026-11-19 by two builds in different directories giving identical packages; CI is the
// cross-machine proof, since it rebuilds and compares on every push.
//
// The record lives in `engine/versions.lock`, between the markers below, written only by this script
// (`wasm_pack` is the one hand-set field, and it is kept): the digest of every source file the module
// is built from, and the sha256 and size of every file in the package. The vitest
// `ui/src/wasm-build-record.test.ts` compares both with the tree, without Rust, so a source change
// without a regeneration fails locally too.
//
// Usage:
//   node scripts/build-wasm.mjs                 rebuild ui/src/wasm-pkg and its record
//   node scripts/build-wasm.mjs --out DIR       build to DIR only (the SDK, a local look)
//   node scripts/build-wasm.mjs --check [--out DIR]
//                                               build to DIR (default a temp dir) and fail unless it
//                                               equals the committed package and the record (CI)
//   node scripts/build-wasm.mjs --wasm-pack-version
//                                               print the pinned wasm-pack version (CI installs it)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CRATE = 'konclave-wasm'
export const PKG = 'ui/src/wasm-pkg'
export const LOCK = 'engine/versions.lock'
export const BEGIN = '# --- BEGIN wasm (written by scripts/build-wasm.mjs; edit only wasm_pack by hand) ---'
export const END = '# --- END wasm ---'

/** What the package is built from, as files: the two crates' manifests and sources and the toolchain
 *  pin. Tests and vectors are not inputs. Three more inputs are digested by `sourceDigest` itself:
 *  the README and LICENSE files at the crate's root (wasm-pack copies them into the package), the
 *  workspace manifest without its member list, and the Cargo.lock entries the module can reach
 *  (the rest of the lock changes with the desktop app and the coordinator, not with the module). */
export const SOURCE_INPUTS = [
  'konclave-wasm/Cargo.toml',
  'konclave-wasm/rust-toolchain.toml',
  'konclave-wasm/src',
  'konclave-seal/Cargo.toml',
  'konclave-seal/src',
]
export const ROOT_CRATE = 'konclave-wasm'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function filesUnder(root, rel) {
  const abs = join(root, rel)
  if (!existsSync(abs)) throw new Error(`build input ${rel} does not exist`)
  if (!statSync(abs).isDirectory()) return [rel]
  return readdirSync(abs, { withFileTypes: true })
    .flatMap((e) => filesUnder(root, join(rel, e.name)))
}

/** The Cargo.lock `[[package]]` blocks reachable from `crate`, as text in lock order. Every
 *  platform's dependencies are kept (the lock does not say which target needs which), so this is a
 *  superset of what the wasm build links, never a subset. */
export function reachableLock(lockText, crate = ROOT_CRATE) {
  const blocks = lockText.split(/^(?=\[\[package\]\]\s*$)/m).filter((b) => b.startsWith('[[package]]'))
  const pkgs = blocks.map((text) => ({
    text: text.trimEnd(),
    name: text.match(/^name = "([^"]+)"/m)?.[1],
    version: text.match(/^version = "([^"]+)"/m)?.[1],
    deps: [...(text.match(/^dependencies = \[([\s\S]*?)^\]/m)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  }))
  const find = (dep) => {
    const [name, version] = dep.split(' ')
    const hits = pkgs.filter((p) => p.name === name && (!version || p.version === version))
    if (hits.length !== 1) throw new Error(`Cargo.lock: dependency "${dep}" matches ${hits.length} packages`)
    return hits[0]
  }
  const start = pkgs.filter((p) => p.name === crate)
  if (start.length !== 1) throw new Error(`Cargo.lock: ${crate} appears ${start.length} times`)
  const seen = new Set()
  const todo = [start[0]]
  while (todo.length) {
    const p = todo.pop()
    if (seen.has(p)) continue
    seen.add(p)
    for (const d of p.deps) todo.push(find(d))
  }
  return pkgs.filter((p) => seen.has(p)).map((p) => p.text).join('\n\n')
}

/** The workspace manifest without comments, blank lines and the member list, which do not change the
 *  module (the resolver and any profile or patch would). */
export function workspaceSettings(manifest) {
  return manifest
    .replace(/^members\s*=\s*\[[^\]]*\]/m, '')
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trimEnd())
    .filter((l) => l && !l.trimStart().startsWith('#'))
    .join('\n')
}

/** One digest over every input: each file's path, length and bytes in path order, then the README and
 *  LICENSE files at the crate root, the workspace settings and the reachable lock entries. */
export function sourceDigest(root = ROOT) {
  const h = createHash('sha256')
  const part = (label, bytes) => {
    h.update(`${label}\0${bytes.length}\0`)
    h.update(bytes)
  }
  const copied = readdirSync(join(root, ROOT_CRATE)).filter((n) => /^(readme|license|copying)/i.test(n)).map((n) => `${ROOT_CRATE}/${n}`)
  // A build script runs at build time and can change the bytes; neither crate has one today.
  for (const c of [ROOT_CRATE, 'konclave-seal']) if (existsSync(join(root, c, 'build.rs'))) copied.push(`${c}/build.rs`)
  const files = [...SOURCE_INPUTS.flatMap((p) => filesUnder(root, p)), ...copied].map((p) => p.split('\\').join('/')).sort()
  for (const f of files) part(f, readFileSync(join(root, f)))
  part('Cargo.toml (workspace settings)', Buffer.from(workspaceSettings(readFileSync(join(root, 'Cargo.toml'), 'utf8'))))
  part(`Cargo.lock (reachable from ${ROOT_CRATE})`, Buffer.from(reachableLock(readFileSync(join(root, 'Cargo.lock'), 'utf8'))))
  return h.digest('hex')
}

/** name -> { sha256, bytes } for every file of a package directory (wasm-pack's .gitignore aside). */
export function packageFiles(dir) {
  const out = {}
  for (const name of readdirSync(dir).sort()) {
    if (name === '.gitignore') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) throw new Error(`${relative(ROOT, p) || p}: a package holds no directories`)
    const bytes = readFileSync(p)
    out[name] = { sha256: sha256(bytes), bytes: bytes.length }
  }
  return out
}

/** The record between the markers of the lock text, or null when there is none. */
export function readRecord(lock) {
  const a = lock.indexOf(BEGIN)
  const b = lock.indexOf(END)
  if (a < 0 && b < 0) return null
  if (a < 0 || b < a || lock.indexOf(BEGIN, a + 1) >= 0 || lock.indexOf(END, b + 1) >= 0) {
    throw new Error(`${LOCK}: the wasm record markers are not one BEGIN followed by one END`)
  }
  const block = lock.slice(a + BEGIN.length, b)
  const field = (text, key) => {
    const m = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm'))
    return m ? m[1] : undefined
  }
  const [head, ...files] = block.split(/^\[\[wasm_file\]\]\s*$/m)
  const record = {
    wasm_pack: field(head, 'wasm_pack'),
    source_digest: field(head, 'source_digest'),
    files: {},
  }
  for (const f of files) {
    const name = field(f, 'name')
    const bytes = f.match(/^bytes\s*=\s*(\d+)\s*$/m)
    if (!name || !bytes || !field(f, 'sha256')) throw new Error(`${LOCK}: a [[wasm_file]] lacks name, sha256 or bytes`)
    record.files[name] = { sha256: field(f, 'sha256'), bytes: Number(bytes[1]) }
  }
  return record
}

export function renderRecord(r) {
  const lines = [
    BEGIN,
    '# The browser module the app ships (ui/src/wasm-pkg). wasm_pack is the pinned tool; the rest is',
    '# what a build of this source produced. CI rebuilds and compares on every push.',
    '[wasm]',
    `wasm_pack     = "${r.wasm_pack}"`,
    `source_digest = "${r.source_digest}"`,
  ]
  for (const [name, f] of Object.entries(r.files)) {
    lines.push('', '[[wasm_file]]', `name   = "${name}"`, `sha256 = "${f.sha256}"`, `bytes  = ${f.bytes}`)
  }
  lines.push(END)
  return lines.join('\n')
}

/** The lock text with its record replaced (or appended when it has none). */
export function withRecord(lock, r) {
  const block = renderRecord(r)
  if (readRecord(lock) === null) return `${lock.replace(/\n*$/, '')}\n\n${block}\n`
  return lock.slice(0, lock.indexOf(BEGIN)) + block + lock.slice(lock.indexOf(END) + END.length)
}

/** Every way `built` (a package dir) and the committed state disagree; empty when they agree. */
export function compare({ built, committed, record, source }) {
  const problems = []
  if (!record) return [`${LOCK} has no wasm record: run node scripts/build-wasm.mjs`]
  const names = new Set([...Object.keys(built), ...Object.keys(committed), ...Object.keys(record.files)])
  for (const n of [...names].sort()) {
    const b = built[n]?.sha256 ?? 'absent'
    const c = committed[n]?.sha256 ?? 'absent'
    const r = record.files[n]?.sha256 ?? 'absent'
    if (b !== c) problems.push(`${PKG}/${n}: the committed file (${c}) is not what this source builds (${b})`)
    if (c !== r) problems.push(`${PKG}/${n}: the committed file (${c}) is not the one ${LOCK} records (${r})`)
    else if (committed[n] && record.files[n].bytes !== committed[n].bytes) problems.push(`${PKG}/${n}: ${LOCK} records ${record.files[n].bytes} bytes, the file has ${committed[n].bytes}`)
  }
  if (record.source_digest !== source) {
    problems.push(`the module's sources changed since the package was built (${LOCK} records ${record.source_digest}, the tree is ${source})`)
  }
  return problems
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()

/** Variables that pick another compiler, wrap it, or change its flags or profile. */
const FOREIGN = /^(RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|RUSTUP_TOOLCHAIN|RUSTFLAGS|RUSTDOCFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_INCREMENTAL|CARGO_BUILD_.*|CARGO_PROFILE_.*|CARGO_UNSTABLE_.*|CARGO_TARGET_.*_RUSTFLAGS|CARGO_TARGET_.*_LINKER)$/i

/** The build's environment: the caller's without anything that changes the compiler or its flags,
 *  plus the path remap, encoded so a path with a space stays one argument. */
export function buildEnv(base, cargoHome, root) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !FOREIGN.test(k)))
  env.CARGO_ENCODED_RUSTFLAGS = [`--remap-path-prefix=${cargoHome}=/cargo`, `--remap-path-prefix=${root}=/src`].join('\x1f')
  return env
}

/** Sections of a cargo config that only reach the network, the terminal or aliases. Anything else
 *  (build, profile, target, patch, source, env, unstable, a top-level key) may change the build. */
const HARMLESS_CONFIG = new Set(['net', 'http', 'registries', 'registry', 'term', 'alias', 'credential-alias', 'cargo-new'])

/** A cargo config that could change the build. */
export function configChangesBuild(text) {
  let section = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const head = line.match(/^\[+\s*([^\].\s]+)/)
    if (head) { section = head[1]; if (!HARMLESS_CONFIG.has(section)) return true; continue }
    if (section === null) return true
  }
  return false
}

/** Every cargo config a build in `dir` reads: the cargo home's, and one in each directory up to `/`. */
export function cargoConfigs(dir, cargoHome) {
  const out = [join(cargoHome, 'config.toml'), join(cargoHome, 'config')]
  for (let d = resolve(dir); ; d = dirname(d)) {
    out.push(join(d, '.cargo/config.toml'), join(d, '.cargo/config'))
    if (dirname(d) === d) break
  }
  return out
}

/** The directory the build writes is emptied first, so it must hold nothing but a package. */
export function outIsSafe(out, root = ROOT) {
  const o = resolve(out)
  if (o === root || root.startsWith(`${o}/`) || o === join(root, PKG)) return false
  if (!existsSync(o)) return true
  if (!statSync(o).isDirectory()) return false
  return readdirSync(o).every((n) => /^(konclave_wasm[\w.]*|package\.json|\.gitignore|readme[\w.]*|license[\w.-]*|copying[\w.]*)$/i.test(n))
}

/** Why a build with this environment and these configs would not be the pinned one; empty when it
 *  would be. The cargo configs read, and a wasm-opt on the PATH (on any OS: `Path` on Windows). */
export function refusals(env, crate, cargoHome) {
  const out = []
  for (const c of cargoConfigs(crate, cargoHome)) {
    if (existsSync(c) && statSync(c).isFile() && configChangesBuild(readFileSync(c, 'utf8'))) {
      out.push(`${c} has settings that can change the module's bytes (allowed: ${[...HARMLESS_CONFIG].join(', ')}); build without it`)
    }
  }
  const path = Object.entries(env).filter(([k]) => k.toUpperCase() === 'PATH').map(([, v]) => v).join(delimiter)
  const onPath = path.split(delimiter).filter(Boolean).find((d) => ['wasm-opt', 'wasm-opt.exe'].some((n) => existsSync(join(d, n))))
  if (onPath) out.push(`a wasm-opt is on the PATH (${onPath}); wasm-pack would use it instead of the binaryen it pins. Build with it off the PATH`)
  return out
}

/** Build the package into `out` with the pinned tools and fixed paths. Throws on a wrong tool. */
export function build(out, record) {
  if (!outIsSafe(out)) throw new Error(`${out} is not empty or a package directory, or it holds the repository: choose another --out`)
  const crate = join(ROOT, CRATE)
  const cargoHome = resolve(process.env.CARGO_HOME || join(homedir(), '.cargo'))
  const env = buildEnv(process.env, cargoHome, ROOT)
  const refused = refusals(env, crate, cargoHome)
  if (refused.length) throw new Error(refused.join('; '))
  const toolchain = readFileSync(join(crate, 'rust-toolchain.toml'), 'utf8').match(/^channel\s*=\s*"([^"]+)"/m)?.[1]
  if (!toolchain) throw new Error(`${CRATE}/rust-toolchain.toml names no channel`)
  const rustc = run('rustc', ['--version'], { cwd: crate, env })
  if (!rustc.startsWith(`rustc ${toolchain} `)) {
    throw new Error(`rustc in ${CRATE} is "${rustc}", the pin is ${toolchain} (rustup toolchain install, in ${CRATE})`)
  }
  const wasmPack = run('wasm-pack', ['--version'], { env })
  if (wasmPack !== `wasm-pack ${record.wasm_pack}`) {
    throw new Error(`"${wasmPack}" is installed, the pin is ${record.wasm_pack} (cargo install wasm-pack --version ${record.wasm_pack} --locked --force)`)
  }
  rmSync(out, { recursive: true, force: true })
  execFileSync('wasm-pack', ['build', '--target', 'web', '--out-dir', out, '--', '--locked'], { cwd: crate, env, stdio: 'inherit' })
  rmSync(join(out, '.gitignore'), { force: true })
}

function main(argv) {
  const lockPath = join(ROOT, LOCK)
  const lock = readFileSync(lockPath, 'utf8')
  const record = readRecord(lock)
  if (argv.includes('--wasm-pack-version')) {
    if (!record?.wasm_pack) throw new Error(`${LOCK} has no wasm_pack pin`)
    process.stdout.write(`${record.wasm_pack}\n`)
    return 0
  }
  if (!record?.wasm_pack) throw new Error(`${LOCK} has no wasm record with a wasm_pack pin`)
  const outAt = argv.indexOf('--out')
  if (outAt >= 0 && !argv[outAt + 1]) throw new Error('--out needs a directory')
  const temp = outAt < 0 ? mkdtempSync(join(tmpdir(), 'konclave-wasm-')) : null
  try {
    return finish(argv, outAt >= 0 ? resolve(argv[outAt + 1]) : join(temp, 'pkg'), outAt >= 0, lock, record)
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}

function finish(argv, out, keep, lock, record) {
  const lockPath = join(ROOT, LOCK)
  build(out, record)
  const built = packageFiles(out)
  const source = sourceDigest()

  if (argv.includes('--check')) {
    const problems = compare({ built, committed: packageFiles(join(ROOT, PKG)), record, source })
    if (problems.length) {
      for (const p of problems) console.error(`wasm-build: ${p}`)
      console.error('wasm-build: regenerate with `node scripts/build-wasm.mjs` and commit the package and engine/versions.lock')
      return 1
    }
    console.log(`wasm-build: ${PKG} is what this source builds, and ${LOCK} records it`)
    return 0
  }

  if (keep) {
    console.log(`wasm-build: built into ${out}; ${PKG} and ${LOCK} left as they are`)
    return 0
  }

  const pkg = join(ROOT, PKG)
  for (const name of Object.keys(packageFiles(pkg))) rmSync(join(pkg, name))
  mkdirSync(pkg, { recursive: true })
  for (const name of Object.keys(built)) cpSync(join(out, name), join(pkg, name))
  writeFileSync(lockPath, withRecord(lock, { wasm_pack: record.wasm_pack, source_digest: source, files: built }))
  console.log(`wasm-build: ${PKG} rebuilt and recorded in ${LOCK}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (e) {
    console.error(`wasm-build: ${e instanceof Error ? e.message : e}`)
    process.exitCode = 1
  }
}
