import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// D: frost-core refuses min_signers < 2 (#589) and the DKG config check says so
// (`quorumIsPossible`), but the bridge's create screen offered a 1-of-n quorum and checked its own
// `threshold < 1`. One rule, read by both.
describe('the create screen asks the same quorum rule as the DKG', () => {
  const src = codeOf('screens/Ceremony.tsx')
  it('validates with quorumIsPossible, not its own floor', () => {
    expect(src).toMatch(/quorumIsPossible\(threshold, names\.length\)/)
    expect(src).not.toMatch(/threshold < 1/)
  })
  it('never offers a quorum of one', () => {
    expect(src).not.toMatch(/\(_, i\) => i \+ 1\)/)
  })
})
