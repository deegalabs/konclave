import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { bundleProblems, carries, envKeysIn, invalidBase, REQUIRED } from '../../scripts/check-desktop-bundle.mjs'

// #664: the desktop release built the app with no coordinator and no relay address, and nothing
// failed. The rule that now fails that build lives in a script so it can be run here; a check that
// exists only as shell in a workflow runs for the first time when a tag is pushed.
const HELPER = 'https://helper.konclave.xyz'
const RELAY = 'https://relay.konclave.xyz'
const good = { VITE_HELPER_BASE: HELPER, VITE_RELAY_BASE: RELAY }
// The shape Vite 8 writes for a static read (`import.meta.env.VITE_HELPER_BASE`): the value alone, as
// a string literal. No env object and no key name: a bundle that carries a key name inlined the whole
// env object, and with it every variable the host injects (Vercel adds its own), so its bytes stop
// being reproducible from the repository (#605).
const bundle = [`const h=\`${HELPER}\`,r=\`${RELAY}\``]

describe('the desktop bundle check (#664, #605)', () => {
  it('passes a bundle that carries both addresses', () => {
    expect(bundleProblems(good, bundle)).toEqual([])
  })

  it('fails an empty or missing helper base', () => {
    expect(bundleProblems({ ...good, VITE_HELPER_BASE: '' }, bundle)[0]).toMatch(/VITE_HELPER_BASE is empty/)
    expect(bundleProblems({ VITE_RELAY_BASE: RELAY }, bundle)[0]).toMatch(/VITE_HELPER_BASE is empty/)
  })

  it('fails an empty relay base', () => {
    expect(bundleProblems({ ...good, VITE_RELAY_BASE: '  ' }, bundle)[0]).toMatch(/VITE_RELAY_BASE is empty/)
  })

  it('fails a value that is set but never reached the bundle', () => {
    // The build that ignored the variable: what v0.8.0 shipped.
    expect(bundleProblems(good, ['const e={}'])).toEqual([
      `VITE_HELPER_BASE=${HELPER} is set but not in the built bundle`,
      `VITE_RELAY_BASE=${RELAY} is set but not in the built bundle`,
    ])
  })

  it('counts a value only as a whole string literal, exactly', () => {
    expect(carries(`const h=\`${HELPER}\``, HELPER)).toBe(true)
    expect(carries(`const h="${HELPER}"`, HELPER)).toBe(true)
    expect(carries(`const h='${HELPER}'`, HELPER)).toBe(true)
    // In a comment, or inside a longer string: not the inlined value.
    expect(carries(`/* see ${HELPER} */ const e={}`, HELPER)).toBe(false)
    expect(carries(`const u="go to ${HELPER}"`, HELPER)).toBe(false)
    // A longer host, or a path after it: not this value.
    expect(carries(`"${HELPER}.evil.example"`, HELPER)).toBe(false)
    expect(carries(`"${HELPER}/x"`, HELPER)).toBe(false)
    // Mismatched quotes are not one literal.
    expect(carries(`"${HELPER}'`, HELPER)).toBe(false)
    // The dot in the host is a dot, not "any character".
    expect(carries(`"https://helperXkonclave.xyz"`, HELPER)).toBe(false)
  })

  it('does not count the addresses the release notes quote (#605 review)', () => {
    // The shape of the release-pages chunk: the changelog in one string, where the #664 entry quotes
    // both addresses in markdown backticks. A text pattern took each for the inlined value, so a
    // desktop build with neither variable passed.
    const notes = [`const p={"0.9.0":"<p>The desktop app now builds with (\`${HELPER}\`, \`${RELAY}\`).</p>"};export{p as default}`]
    expect(bundleProblems(good, notes)).toEqual([
      `VITE_HELPER_BASE=${HELPER} is set but not in the built bundle`,
      `VITE_RELAY_BASE=${RELAY} is set but not in the built bundle`,
    ])
  })

  it('fails a bundle that inlined an env object, naming each key it carries', () => {
    // What v0.21.0 shipped: three files aliased `import.meta.env`, so Vite wrote the whole object,
    // including a variable only Vercel sets.
    const inlined = [`const e={VITE_HELPER_BASE:\`${HELPER}\`,VITE_RELAY_BASE:\`${RELAY}\`,VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG:\`{}\`}`]
    expect(bundleProblems(good, inlined)).toEqual([
      'the bundle carries the env key VITE_HELPER_BASE: an env object was inlined, so its bytes depend on whatever variables the host sets (read import.meta.env.VITE_<NAME> directly)',
      'the bundle carries the env key VITE_RELAY_BASE: an env object was inlined, so its bytes depend on whatever variables the host sets (read import.meta.env.VITE_<NAME> directly)',
      'the bundle carries the env key VITE_VERCEL_OBSERVABILITY_CLIENT_CONFIG: an env object was inlined, so its bytes depend on whatever variables the host sets (read import.meta.env.VITE_<NAME> directly)',
    ])
  })

  it('finds a key name only as an object key', () => {
    expect(envKeysIn('const e={VITE_A_B1:1,"VITE_b":2,INVITE_LENGTH:3,xVITE_C:4};const s="VITE_PROSE";VITE_IDENT')).toEqual(['VITE_A_B1', 'VITE_b'])
    expect(envKeysIn('const a=1')).toEqual([])
  })

  it('checks only the key names for the web build, which has no addresses to require', () => {
    expect(bundleProblems({}, bundle, { web: true })).toEqual([])
    expect(bundleProblems({}, ['({VITE_X:1})'], { web: true })).toHaveLength(1)
  })

  it('accepts only an https origin, spelled as the coordinator matches it', () => {
    expect(invalidBase('X', HELPER)).toBeNull()
    expect(invalidBase('X', 'http://helper.konclave.xyz')).toMatch(/https/)
    expect(invalidBase('X', `${HELPER}/`)).toMatch(/origin/)
    expect(invalidBase('X', `${RELAY}:443`)).toMatch(/origin/)
    expect(invalidBase('X', 'helper.konclave.xyz')).toMatch(/not a URL/)
  })
})

describe('the desktop release workflow (#664)', () => {
  const root = join(__dirname, '..', '..')
  const wf = readFileSync(join(root, '.github', 'workflows', 'desktop-release.yml'), 'utf8')
  const csp = readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')

  it('builds with the production coordinator and relay', () => {
    expect(wf).toMatch(new RegExp(`^\\s+VITE_HELPER_BASE: ${HELPER}$`, 'm'))
    expect(wf).toMatch(new RegExp(`^\\s+VITE_RELAY_BASE: ${RELAY}$`, 'm'))
  })

  it('runs the bundle check after the build and the service-worker check, before the installers', () => {
    // The CLI, not the rule module: the rule file runs nothing when executed.
    const build = wf.indexOf('pnpm -C ui run build')
    const sw = wf.indexOf('node scripts/check-sw-cli.mjs')
    const check = wf.indexOf('node scripts/check-desktop-bundle-cli.mjs')
    const installers = wf.indexOf('tauri-apps/tauri-action@')
    expect(build).toBeGreaterThan(-1)
    expect(sw).toBeGreaterThan(build)
    expect(check).toBeGreaterThan(sw)
    expect(installers).toBeGreaterThan(check)
    expect(wf).not.toContain('node scripts/check-desktop-bundle.mjs')
  })

  it('every address it builds with is one the desktop CSP admits', () => {
    // A base the CSP refuses fails silently in the app: a CSP refusal is not an error a fetch reports.
    for (const name of REQUIRED as string[]) {
      const value = wf.match(new RegExp(`^\\s+${name}: (\\S+)$`, 'm'))?.[1]
      expect(value, name).toBeTruthy()
      expect(csp).toContain(` ${value} `)
    }
  })
})

describe('the web build check in ci.yml (#605)', () => {
  const ci = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  const steps = ci.split(/\n(?=\s+- (?:name|uses|run): )/)
  it('builds with a canary variable nothing reads, then checks for env key names', () => {
    const b = steps.findIndex((x) => /run: pnpm -C ui run build\b/.test(x))
    expect(b).toBeGreaterThan(-1)
    expect(steps[b]).toMatch(/^\s+VITE_KONCLAVE_CI_CANARY: \S+$/m)
    const check = steps.findIndex((x) => /run: node scripts\/check-desktop-bundle-cli\.mjs --web ui\/dist/.test(x))
    expect(check).toBeGreaterThan(b)
  })
})
