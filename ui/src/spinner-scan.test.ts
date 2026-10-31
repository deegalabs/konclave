import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// #320: loading is a skeleton in the shape of the content to come, never a
// generic spinner in its place. The screens converted here must not reach for <Loading/> again.

describe('loading is a skeleton, not a spinner', () => {
  for (const f of ['Members.tsx', 'NewPayment.tsx', 'NewPayroll.tsx', 'Settings.tsx']) {
    it(`${f} draws a skeleton while it loads`, () => {
      const src = codeOf(`screens/${f}`)
      expect(src).not.toMatch(/<Loading\b/)
      expect(src).toMatch(/<Skeleton(Rows|Roster|Form|Stat|Detail)?\b/)
    })
  }
})
