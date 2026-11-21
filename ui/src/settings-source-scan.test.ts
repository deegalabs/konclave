import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// T12: Settings reads the selection ONCE (the pin at mount) and asks the shared guard in every
// handler that acts. A second read, or a handler without the guard, is the defect again.
describe('Settings acts through the one guard', () => {
  const code = codeOf('screens/Settings.tsx')
  it('reads the selection once, for the pin', () => {
    expect(code.match(/getSelectedVault\(/g) ?? []).toHaveLength(1)
    expect(code).toMatch(/useState\(\(\) => getSelectedVault\(\)\)/)
  })
  it.each(['doRotate', 'runExport', 'addPasskey', 'dropPasskey', 'removeFromDevice'])('%s asks shownVault before any await', (fn) => {
    const m = new RegExp(`(?:async )?function ${fn}\\b[\\s\\S]*?\\n  \\}\\n`).exec(code)
    expect(m, fn).toBeTruthy()
    const body = m![0]
    const guard = body.indexOf('shownVault(')
    expect(guard, fn).toBeGreaterThan(-1)
    const firstAwait = body.indexOf('await ')
    if (firstAwait !== -1) expect(guard, fn).toBeLessThan(firstAwait)
  })
})
