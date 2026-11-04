import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { bundleProblems, invalidBase, REQUIRED } from '../../scripts/check-desktop-bundle.mjs'

// #664: the desktop release built the app with no coordinator and no relay address, and nothing
// failed. The rule that now fails that build lives in a script so it can be run here; a check that
// exists only as shell in a workflow runs for the first time when a tag is pushed.
const HELPER = 'https://helper.konclave.xyz'
const RELAY = 'https://relay.konclave.xyz'
const good = { VITE_HELPER_BASE: HELPER, VITE_RELAY_BASE: RELAY }
const bundle = [`const e={VITE_HELPER_BASE:"${HELPER}",VITE_RELAY_BASE:"${RELAY}"}`]

describe('the desktop bundle check (#664)', () => {
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

  it('runs the bundle check after building the app and before building the installers', () => {
    const build = wf.indexOf('pnpm -C ui run build')
    const check = wf.indexOf('node scripts/check-desktop-bundle.mjs')
    const installers = wf.indexOf('tauri-apps/tauri-action@')
    expect(build).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(build)
    expect(installers).toBeGreaterThan(check)
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
