import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// #292: the stamp wording for a device with no known member name, and the clock rule for an open
// proposal past its deadline, live once in desk.ts. The Dashboard reads them from there; a second
// copy in the screen is how the list and the Dashboard came to disagree.
describe('the Dashboard reads the desk rules from desk.ts', () => {
  const src = codeOf('screens/Dashboard.tsx')
  it('imports stampKey and expiredByClock from desk.ts', () => {
    const imp = src.match(/import \{([^}]*)\} from '\.\.\/desk'/)
    expect(imp, "an import from '../desk'").toBeTruthy()
    expect(imp![1]).toMatch(/\bstampKey\b/)
    expect(imp![1]).toMatch(/\bexpiredByClock\b/)
  })
  it('keeps no copy of stampKey of its own', () => {
    expect(src).not.toMatch(/function stampKey\s*\(/)
    expect(src).not.toMatch(/const stampKey\s*=/)
  })
  it('ranks the desk without the proposals whose clock has run out', () => {
    expect(src).toMatch(/rankDesk\(.*expiredByClock/)
  })
})
