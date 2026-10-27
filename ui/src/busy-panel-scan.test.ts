import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// The signing panel is not rendered by any test, so what it does with a send that ended "busy" is held
// by what the code can say. A busy send must never withdraw anyone's consent (the member's approval and
// the others' still stand); the one rule that decides which ending withdraws is `applyPlan`, and it
// reaches `unarmActive` through ONE guarded call. A second reference anywhere else in the panel, in an
// effect, a handler or a prop, is a second way to withdraw, and the first one a busy ending would find.
describe('the signing panel withdraws consent in one place only', () => {
  const panel = codeOf('./screens/SigningPanel.tsx')

  it('names unarmActive twice: where it is taken from the signer, and the one guarded call', () => {
    const named = panel.match(/\bunarmActive\b/g) ?? []
    expect(named.length, 'unarmActive is named a third time in the signing panel').toBe(2)
  })

  it('the one call is the plan\'s own withdrawal, and nothing else decides it', () => {
    expect(panel).toMatch(/if \(plan\.withdraw !== null\) void unarmActive\(errorCode\(plan\.withdraw\)\)/)
  })
})
