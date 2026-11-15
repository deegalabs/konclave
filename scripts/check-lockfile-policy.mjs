#!/usr/bin/env node
// Checks the COMMITTED lockfile against pnpm-workspace.yaml's supply-chain settings (#820). Why it
// exists and how CI runs it: the comment above the lockfile-policy job in .github/workflows/ci.yml.
//
// pnpm 12 re-applies minimumReleaseAge and trustPolicy to every locked entry (`trustLockfile` is
// false by default), so this runs pnpm 12, pinned by tarball integrity and installed without its
// install scripts, ONLY to verify, in a temporary copy of the manifests with a fresh store and cache.
// The rule is pnpm's; this file runs it and reads the answer. Before verifying it refuses settings
// weaker than documented: the keys pnpm itself resolves (`config list --json`, not a second YAML
// reader) must be on an allowlist, .npmrc may hold nothing but engine-strict, and no pnpmfile runs. After, two controls must be refused (no trust excludes; an absurd minimum age), so a
// pnpm that skipped the verification fails. Outcomes: passes / refused (pnpm named a policy or
// integrity violation) / could not verify (anything else; never a pass). Runs on linux-x64.
//
// Usage: node scripts/check-lockfile-policy.mjs   (needs network to registry.npmjs.org)
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PNPM_VERIFY_VERSION = '12.21.0'
const PINNED = {
  [`pnpm@${PNPM_VERIFY_VERSION}`]: 'sha512-Zv2CeO4ok1zpUXktNDZ/869cQyonVkRYIwKVM4NbjaUpu+C+UTCv1W7QcT+4eJ5Hutgtk71a4v5UsVVi1idu8A==',
  [`@pnpm/exe.linux-x64@${PNPM_VERIFY_VERSION}`]: 'sha512-8eufCjHXspKbNS/kh8q4Q0gqJoOuvC4Q5pgos6XS8By/nAMtP+jf8F1Cw9er840kfAX+PJ/ts+A9qnLE91rvXQ==',
}
const MIN_AGE_MINUTES = 1440
const PASSED = /Lockfile passes supply-chain policies/
export const REFUSALS = [
  'ERR_PNPM_TRUST_DOWNGRADE',
  'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
  // A locked tarball that is not what the registry serves is a refusal, not an outage.
  'ERR_PNPM_TARBALL_URL_MISMATCH',
  'ERR_PNPM_MISSING_TARBALL_INTEGRITY',
  'ERR_PNPM_TARBALL_INTEGRITY',
]
const RUN_TIMEOUT_MS = 90_000

/** pnpm's answer, from its exit status and output. */
export function classify(status, output) {
  // The pass counts only from the pinned pnpm: a manifest can make pnpm hand the install to another
  // release, and that release's answer is not the one this check vouches for.
  if (status === 0 && PASSED.test(output) && output.includes(`using pnpm v${PNPM_VERIFY_VERSION}`)) return { outcome: 'passes' }
  const codes = REFUSALS.filter((c) => output.includes(c))
  if (status !== 0 && codes.length > 0) return { outcome: 'refused', codes }
  return { outcome: 'could not verify' }
}

// The registries pnpm 12.21.0 knows by default, as `config list --json` reports them: anything else
// (another default registry, a scope sent elsewhere) is an override.
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const DEFAULT_REGISTRIES = {
  'https://npm.jsr.io/': { scopes: ['@jsr'] },
  'https://npm.pkg.github.com/': { prefix: 'gh' },
  'https://registry.npmjs.org/': { scopes: ['@'], prefix: 'npmjs' },
}
const EXACT = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/

// Every key `config list --json` may report for this repository. Anything else (a proxy, TLS off, a
// pnpmfile, another policy knob) is refused rather than judged: an allowlist, not a list of bad keys.
const ALLOWED_KEYS = new Set(['@jsr:registry', 'blockExoticSubdeps', 'ignorePnpmfile', 'minimumReleaseAge', 'packages', 'registries', 'registry', 'trustPolicy', 'trustPolicyExclude', 'userAgent'])

/**
 * Why the settings are weaker than documented; empty when they are not. `config` is what the pinned
 * pnpm resolved (`config list --json`, run with --ignore-pnpmfile); `npmrc` is the committed .npmrc,
 * read too because some of its keys (a proxy, TLS) never show in that list.
 */
export function weakenings(config, npmrc) {
  const why = []
  for (const key of Object.keys(config)) if (!ALLOWED_KEYS.has(key)) why.push(`the setting "${key}" is not allowed`)
  if (config.ignorePnpmfile !== true) why.push('the pnpmfile must be ignored')
  for (const line of npmrc.split('\n').map((l) => l.trim())) {
    if (line && !line.startsWith('#') && !line.startsWith(';') && line !== 'engine-strict=true') why.push(`.npmrc line "${line}" is not allowed`)
  }
  if (!(Number(config.minimumReleaseAge) >= MIN_AGE_MINUTES)) why.push(`minimumReleaseAge must be at least ${MIN_AGE_MINUTES}`)
  if (config.trustPolicy !== 'no-downgrade') why.push('trustPolicy must be no-downgrade')
  if (config.blockExoticSubdeps !== true) why.push('blockExoticSubdeps must be true')
  if (config.minimumReleaseAgeExclude !== undefined && [].concat(config.minimumReleaseAgeExclude).length > 0) why.push('minimumReleaseAgeExclude is not allowed')
  if (config.trustPolicyIgnoreAfter !== undefined) why.push('trustPolicyIgnoreAfter is not allowed')
  if (config.trustLockfile === true) why.push('trustLockfile is not allowed')
  for (const entry of [].concat(config.trustPolicyExclude ?? [])) {
    if (!EXACT.test(String(entry))) why.push(`trustPolicyExclude entry "${entry}" is not name@exact-version`)
  }
  if (config.registry !== DEFAULT_REGISTRY) why.push(`the registry must be ${DEFAULT_REGISTRY}`)
  if (JSON.stringify(config.registries) !== JSON.stringify(DEFAULT_REGISTRIES)) why.push('no registry may be added or overridden')
  return why
}

/** Why the manifests or the lockfile could hand the verification to another pnpm; empty when not. */
export function handoffs(manifests, lock) {
  const why = []
  for (const [path, text] of Object.entries(manifests)) {
    if (JSON.parse(text).devEngines?.packageManager !== undefined) why.push(`${path} sets devEngines.packageManager`)
  }
  const head = lock.split(/^importers:/m)[0]
  for (const key of ['packageManagerDependencies', 'configDependencies']) {
    if (new RegExp(`^\\s*${key}:`, 'm').test(head)) why.push(`pnpm-lock.yaml sets ${key}`)
  }
  return why
}

/** The workspace file with the trust excludes removed (the first control). */
export function withoutTrustExcludes(workspace) {
  const out = workspace.replace(/^trustPolicyExclude:[ \t]*\n(?:(?:[ \t].*)?\n)*/m, '')
  if (out === workspace || /trustPolicyExclude/.test(out)) throw new Error('could not remove trustPolicyExclude from pnpm-workspace.yaml')
  return out
}

/** The workspace file with a minimum age (ten years) that the locked packages cannot all meet. */
export function withAbsurdAge(workspace) {
  const out = workspace.replace(/^minimumReleaseAge:\s*\d+/m, 'minimumReleaseAge: 5256000')
  if (out === workspace) throw new Error('pnpm-workspace.yaml sets no minimumReleaseAge')
  return out
}

class Failure extends Error {
  constructor(message, output) {
    super(message)
    this.output = output
  }
}

function installPinnedPnpm(dir) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Failure('runs on linux-x64 only (the CI runner): the pinned pnpm binary is that one')
  mkdirSync(dir, { recursive: true })
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', ...Object.keys(PINNED)], { cwd: dir, encoding: 'utf8', timeout: 120_000 }))
  const files = Object.entries(PINNED).map(([spec, integrity]) => {
    const got = packed.find((p) => `${p.name}@${p.version}` === spec)
    if (!got || got.integrity !== integrity) throw new Failure(`${spec}: the downloaded tarball is not the pinned one (${got?.integrity ?? 'missing'})`)
    return `./${got.filename}`
  })
  execFileSync('npm', ['install', '--silent', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(dir, 'inst'), ...files], { cwd: dir, stdio: 'inherit', timeout: 120_000 })
  // The pinned binary itself, not the package's wrapper (which picks a binary, or downloads one).
  const pnpm = join(dir, 'inst', 'node_modules', '@pnpm', 'exe.linux-x64', 'pnpm')
  // From a directory with no package.json: inside the repository the 10.x pin would answer instead.
  const version = execFileSync(pnpm, ['--version'], { cwd: dir, encoding: 'utf8', timeout: 30_000 }).trim()
  if (version !== PNPM_VERIFY_VERSION) throw new Failure(`the pinned pnpm reports ${version}, not ${PNPM_VERIFY_VERSION}`)
  return pnpm
}

function main() {
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const work = mkdtempSync(join(tmpdir(), 'konclave-lockfile-policy-'))
  try {
    const workspace = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')
    const pnpm = installPinnedPnpm(join(work, 'pnpm'))
    // Every manifest pnpm reads: the root files and each tracked package.json (the workspace packages
    // and the local wasm package one of them depends on). Nothing else is needed to verify.
    const files = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', ...execFileSync('git', ['ls-files', '*package.json'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean)]
    const lock = readFileSync(join(repo, 'pnpm-lock.yaml'), 'utf8')
    const copy = (name, ws) => {
      const dir = join(work, name)
      for (const f of files) {
        mkdirSync(dirname(join(dir, f)), { recursive: true })
        cpSync(join(repo, f), join(dir, f))
      }
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), ws)
      // With the 10.x pin present, pnpm 12 stops before verifying (ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE).
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      delete pkg.packageManager
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
      return dir
    }
    const run = (name, ws) => {
      const dir = copy(name, ws)
      const r = spawnSync(pnpm, ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-pnpmfile', '--store-dir', join(dir, '.store'), `--config.cache-dir=${join(dir, '.cache')}`], { cwd: dir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS })
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
      return { ...classify(r.status, output), output, rewrote: readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8') !== lock }
    }

    const manifests = Object.fromEntries(files.filter((f) => f.endsWith('package.json')).map((f) => [f, readFileSync(join(repo, f), 'utf8')]))
    const handed = handoffs(manifests, lock)
    if (handed.length) throw new Failure(`the verification could be handed to another pnpm: ${handed.join('; ')}`)
    const configDir = copy('config', workspace)
    const config = JSON.parse(execFileSync(pnpm, ['config', 'list', '--json', '--ignore-pnpmfile'], { cwd: configDir, encoding: 'utf8', timeout: 30_000 }))
    const weak = weakenings(config, readFileSync(join(repo, '.npmrc'), 'utf8'))
    if (weak.length) throw new Failure(`the supply-chain settings are weaker than documented: ${weak.join('; ')}`)

    const real = run('real', workspace)
    if (real.outcome === 'could not verify') throw new Failure('could not verify the lockfile: pnpm neither passed it nor named a policy violation (a registry outage, a timeout, or another failure, shown below); read the output before running it again', real.output)
    if (real.outcome === 'refused') throw new Failure(`the lockfile holds an entry pnpm-workspace.yaml's settings refuse (${real.codes.join(', ')}); see the entries named below`, real.output)
    if (real.rewrote) throw new Failure('the verification rewrote the lockfile: it no longer matches the manifests', real.output)
    console.log(`passes: ${real.output.split('\n').find((l) => PASSED.test(l)).trim()}`)

    const trust = run('control-trust', withoutTrustExcludes(workspace))
    if (!(trust.outcome === 'refused' && trust.codes.includes('ERR_PNPM_TRUST_DOWNGRADE') && trust.output.includes('semver@6.3.1'))) {
      throw new Failure(`control: with the trust excludes removed, pnpm did not refuse semver@6.3.1 (${trust.outcome}), so the trust policy is not being applied`, trust.output)
    }
    console.log('control passes: without the excludes the trust policy refuses semver@6.3.1')

    const age = run('control-age', withAbsurdAge(workspace))
    if (!(age.outcome === 'refused' && age.codes.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION'))) {
      throw new Failure(`control: with an absurd minimum age, pnpm did not refuse on age (${age.outcome}), so the age policy is not being applied`, age.output)
    }
    console.log('control passes: an absurd minimum age is refused')
  } catch (e) {
    console.error(`::error::${e.message}`)
    if (e.output) console.error(e.output.split('\n').slice(-40).join('\n'))
    process.exitCode = 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Compared by real path, so a checkout under a path with spaces or behind a symlink still runs.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main()
