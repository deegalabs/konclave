import { describe, expect, it } from 'vitest'
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

  it('sends the web, the desktop shell and the shared crates to the root file', () => {
    // Shared crates map to the root deliberately. A change in `konclave-seal` can reach the
    // desktop, the coordinator and the browser at once, and naming one product would be a guess.
    expect(requiredChangelogs(['ui/src/api.ts', 'konclave-seal/src/lib.rs', 'orchestrator/src/send.rs']))
      .toEqual(['CHANGELOG.md'])
  })

  it('asks for BOTH when a PR crosses products', () => {
    expect(requiredChangelogs(['ui/src/api.ts', 'helper-server/src/main.rs']))
      .toEqual(['CHANGELOG.md', 'helper-server/CHANGELOG.md'])
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
})
