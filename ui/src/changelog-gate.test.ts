import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error - a plain .mjs script, deliberately not part of the app's TS build
import { requiredChangelogs, missingChangelogs, OWNERS } from '../../scripts/changelog-gate.mjs'

// The gate that decides whether a PR must write a changelog entry, and now WHICH one.
//
// This rule lived as shell inside `ci.yml`, where nobody could run it. It had already shipped one
// real bug there - diffing from `base.sha` rather than the merge base, so it passed a PR whose only
// file was `ui/src/theme.ts` by sweeping in the base branch's own changelog commit. That was caught
// by hand. Moving the rule into a script is what makes these cases cheap to state.
describe('which changelog a change must touch', () => {
  it('sends the coordinator and the relay to their own files', () => {
    expect(requiredChangelogs(['helper-server/src/main.rs'])).toEqual(['helper-server/CHANGELOG.md'])
    expect(requiredChangelogs(['relay-server/src/main.rs'])).toEqual(['relay-server/CHANGELOG.md'])
  })

  it('sends the app to its own file', () => {
    // The web and the desktop both ship it. One entry, where the change lives, rather than two that
    // drift - which is the failure this repo keeps meeting in other forms.
    expect(requiredChangelogs(['ui/src/api.ts'])).toEqual(['ui/CHANGELOG.md'])
  })

  it('sends the desktop shell and the shared crates to the root file', () => {
    // Shared crates map to the root deliberately. A change in `konclave-seal` can reach the
    // desktop, the coordinator and the browser at once, and naming one product would be a guess.
    expect(requiredChangelogs(['src-tauri/src/main.rs', 'konclave-seal/src/lib.rs', 'orchestrator/src/send.rs']))
      .toEqual(['CHANGELOG.md'])
  })

  it('the desktop shell is covered at all, which it was not', () => {
    // `src-tauri/` appeared in no owner list before this, so changing the shell required no
    // changelog of any kind. Nobody had noticed, because the shell moves rarely - which is exactly
    // the kind of gap that is found the once it matters.
    expect(requiredChangelogs(['src-tauri/src/main.rs'])).not.toEqual([])
  })

  it('asks for BOTH when a PR crosses products', () => {
    expect(requiredChangelogs(['ui/src/api.ts', 'helper-server/src/main.rs']))
      .toEqual(['helper-server/CHANGELOG.md', 'ui/CHANGELOG.md'])
  })

  it('the root changelog does not satisfy a service change', () => {
    // The failure this split exists to prevent. Before it, touching the root file was enough for
    // anything, so a coordinator change - the kind that took the vault down for a morning - could
    // be recorded under the web app's notes or nowhere in particular.
    expect(missingChangelogs(['helper-server/src/main.rs', 'CHANGELOG.md']))
      .toEqual(['helper-server/CHANGELOG.md'])
  })

  it('has no opinion about tests, e2e or anything outside a product', () => {
    expect(requiredChangelogs([
      'ui/src/api.test.ts',
      'ui/e2e/smoke.spec.ts',
      '.github/workflows/ci.yml',
      'docs/PROOF.md',
      'README.md',
    ])).toEqual([])
  })

  it('every owner maps to a file that is actually named CHANGELOG.md', () => {
    // Cheap, and it catches the typo that would silently require a file nobody will ever create.
    for (const [prefix, file] of OWNERS) {
      expect(file, `${prefix} points at something that is not a changelog`).toMatch(/(^|\/)CHANGELOG\.md$/)
    }
  })

  it('every changelog it names exists, and in the form the release script reads', () => {
    // A guard against a failure that is SILENT in both directions. `scripts/release.mjs` finds a
    // section with `l.includes('[Unreleased]')` - brackets included - and returns an empty string
    // when it finds nothing. So a file written with `## Unreleased` contributes nothing to a
    // release body and says so nowhere.
    //
    // This is not hypothetical: all three new changelogs were written that way and caught by
    // running `--notes` rather than by reading them. A missing file fails the same way, quietly.
    const repo = join(new URL('.', import.meta.url).pathname, '..', '..')
    for (const [, file] of OWNERS) {
      const md = readFileSync(join(repo, file), 'utf8')
      expect(md.includes('[Unreleased]'), `${file} has no "## [Unreleased]" the release script can find`).toBe(true)
    }
  })
})
