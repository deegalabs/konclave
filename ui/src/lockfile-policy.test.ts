import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { classify, handoffs, weakenings, withAbsurdAge, withoutTrustExcludes } from '../../scripts/check-lockfile-policy.mjs'

// The CI check of the lockfile against the supply-chain settings (#820) runs pnpm 12 and reads its
// answer. These pin how it reads that answer, so that red means "refused", a registry outage is never
// read as a pass, and its two controls really take the rules away.
const workspace = readFileSync(fileURLToPath(new URL('../../pnpm-workspace.yaml', import.meta.url)), 'utf8')

describe('reading what pnpm answered', () => {
  it('passes only on a clean exit that says the lockfile passes', () => {
    expect(classify(0, '✓ Lockfile passes supply-chain policies (646 entries in 4.4s)\nDone in 4.5s using pnpm v12.21.0')).toEqual({ outcome: 'passes' })
    // The same words from another pnpm release, which a manifest can make pnpm hand the install to.
    expect(classify(0, '✓ Lockfile passes supply-chain policies (646 entries)\nDone in 1s using pnpm v12.20.0').outcome).toBe('could not verify')
    expect(classify(0, '✓ Lockfile passes supply-chain policies (646 entries)').outcome).toBe('could not verify')
    // The version line counts only as the last line: the one the release that ran prints.
    expect(classify(0, 'Done in 1s using pnpm v12.21.0\n✓ Lockfile passes supply-chain policies\nDone in 1s using pnpm v12.20.0').outcome).toBe('could not verify')
    // A clean exit that did not say it verified anything (a pnpm that skipped the check) is not a pass.
    expect(classify(0, 'Done in 1.1s using pnpm v12.21.0').outcome).toBe('could not verify')
  })

  it('reads a named policy violation as refused, with the rule it broke', () => {
    expect(classify(1, 'Error: ERR_PNPM_TRUST_DOWNGRADE\n undici-types@6.21.0 High-risk trust downgrade')).toEqual({
      outcome: 'refused',
      codes: ['ERR_PNPM_TRUST_DOWNGRADE'],
    })
    expect(classify(1, 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION').outcome).toBe('refused')
  })

  it('trusts neither half alone: a refusal code with a clean exit, or the pass line with a failed one', () => {
    expect(classify(0, 'ERR_PNPM_TRUST_DOWNGRADE').outcome).toBe('could not verify')
    expect(classify(1, '✓ Lockfile passes supply-chain policies (646 entries)').outcome).toBe('could not verify')
  })

  it('reads a locked tarball the registry does not serve as refused, not as an outage', () => {
    expect(classify(1, 'ERR_PNPM_TARBALL_URL_MISMATCH').outcome).toBe('refused')
    expect(classify(1, 'ERR_PNPM_MISSING_TARBALL_INTEGRITY').outcome).toBe('refused')
  })

  it('reads a registry it could not reach as "could not verify", never as a pass or a refusal', () => {
    expect(classify(1, 'ERR_PNPM_META_FETCH_FAIL GET http://127.0.0.1:9/semver: connect ECONNREFUSED').outcome).toBe('could not verify')
    expect(classify(null, '').outcome).toBe('could not verify') // killed by the timeout
  })
})

describe('the controls take the rules away', () => {
  it('removes every trust exclude and nothing else', () => {
    const out = withoutTrustExcludes(workspace)
    expect(workspace).toContain('trustPolicyExclude:')
    expect(out).not.toContain('trustPolicyExclude')
    expect(out).not.toMatch(/^\s+- (semver|undici-types|"@trickfilm400)/m)
    for (const key of ['packages:', 'minimumReleaseAge:', 'trustPolicy: no-downgrade', 'blockExoticSubdeps: true']) expect(out).toContain(key)
  })

  it('sets a ten-year minimum age, which the locked packages cannot all meet, and refuses a workspace without one', () => {
    expect(withAbsurdAge(workspace)).toMatch(/^minimumReleaseAge: 5256000/m)
    expect(() => withAbsurdAge('packages:\n  - ui\n')).toThrow(/no minimumReleaseAge/)
  })
})

// What `pnpm config list --json` (pnpm 12.21.0) reports for the committed workspace and .npmrc.
const resolved = {
  '@jsr:registry': 'https://npm.jsr.io/',
  ignorePnpmfile: true,
  packages: ['ui', 'mcp-server', 'sdk'],
  userAgent: 'pnpm/12.21.0 npm/? node/? linux x64',
  minimumReleaseAge: 1440,
  trustPolicy: 'no-downgrade',
  blockExoticSubdeps: true,
  trustPolicyExclude: ['semver@6.3.1', '@trickfilm400/rollup-plugin-off-main-thread@3.0.0-pre1', 'undici-types@6.21.0'],
  registry: 'https://registry.npmjs.org/',
  registries: {
    'https://npm.jsr.io/': { scopes: ['@jsr'] },
    'https://npm.pkg.github.com/': { prefix: 'gh' },
    'https://registry.npmjs.org/': { scopes: ['@'], prefix: 'npmjs' },
  },
}

const npmrc = 'engine-strict=true\n'

describe('settings weaker than documented are refused, as pnpm itself resolved them', () => {
  it('accepts the settings as committed', () => {
    expect(weakenings(resolved, npmrc)).toEqual([])
  })

  it('refuses each weakening, naming it', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ minimumReleaseAge: 1 }, 'minimumReleaseAge'],
      [{ minimumReleaseAge: undefined }, 'minimumReleaseAge'],
      [{ trustPolicy: 'off' }, 'trustPolicy'],
      [{ blockExoticSubdeps: false }, 'blockExoticSubdeps'],
      [{ trustPolicyExclude: [...resolved.trustPolicyExclude, 'evil-pkg'] }, 'name@exact-version'],
      [{ trustPolicyExclude: ['evil-*@1.0.0'] }, 'name@exact-version'],
      [{ minimumReleaseAgeExclude: ['left-pad'] }, 'minimumReleaseAgeExclude'],
      [{ trustPolicyIgnoreAfter: 60 }, 'trustPolicyIgnoreAfter'],
      [{ trustLockfile: true }, 'trustLockfile'],
      [{ registry: 'https://example.invalid/' }, 'registry'],
      [{ registries: { ...resolved.registries, 'https://example.invalid/': { scopes: ['@evil'] } } }, 'registry'],
      // Not on the allowlist: refused without being judged.
      [{ pnpmfile: '/somewhere/hook.cjs' }, '"pnpmfile" is not allowed'],
      [{ httpsProxy: 'http://127.0.0.1:8080' }, '"httpsProxy" is not allowed'],
      [{ strictSsl: false }, '"strictSsl" is not allowed'],
      [{ ignorePnpmfile: undefined }, 'pnpmfile must be ignored'],
    ]
    for (const [change, named] of cases) expect(weakenings({ ...resolved, ...change }, npmrc).join(' '), named).toContain(named)
  })

  it('reads .npmrc for what never shows in the resolved list, and allows only engine-strict there', () => {
    expect(weakenings(resolved, '# a comment\n\nengine-strict=true\n')).toEqual([])
    for (const line of ['https-proxy=http://127.0.0.1:8080', 'strict-ssl=false', 'registry=https://example.invalid/']) {
      expect(weakenings(resolved, `engine-strict=true\n${line}\n`).join(' '), line).toContain(line)
    }
  })

  it('removing the excludes fails loudly when there is nothing to remove', () => {
    expect(() => withoutTrustExcludes('packages:\n  - ui\n')).toThrow(/could not remove/)
  })
})

describe('nothing hands the verification to another pnpm', () => {
  const lock = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n\n  .: {}\n"
  it('accepts manifests and a lockfile as committed', () => {
    expect(handoffs({ 'package.json': '{"name":"konclave","packageManager":"pnpm@10.34.9"}' }, lock)).toEqual([])
  })

  it('refuses devEngines.packageManager in any manifest, and a package-manager block in the lockfile', () => {
    const dev = '{"devEngines":{"packageManager":{"name":"pnpm","version":"12.20.0","onFail":"download"}}}'
    expect(handoffs({ 'sdk/package.json': dev }, lock).join(' ')).toContain('sdk/package.json sets devEngines.packageManager')
    // The shape pnpm 12.21.0 writes: a first document, the keys under `importers: .:`.
    const written = "---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.20.0\n\n---\n" + lock
    const why = handoffs({}, written).join(' ')
    for (const named of ['more than one document', 'packageManagerDependencies', 'configDependencies']) expect(why, named).toContain(named)
  })
})
