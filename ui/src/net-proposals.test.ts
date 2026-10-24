import { describe, expect, it } from 'vitest'
import { codeAt } from './source-scan'
import { proposalsReadable } from './net-proposals'

// The /net screen reads a vault's proposals only once the coordinator knows the vault. During a
// creation that is after the registration (every new member got a 404 before); a vault opened from
// this device (restored) or in a signing session is already registered, and must load its ready
// proposals on its own, as it did before.
describe('proposalsReadable', () => {
  it('waits for the registration during a creation', () => {
    for (const phase of ['idle', 'roster', 'confirm', 'dkg', 'done', 'error'] as const) {
      expect(proposalsReadable(phase, 'idle'), phase).toBe(false)
      expect(proposalsReadable(phase, 'registering'), phase).toBe(false)
      expect(proposalsReadable(phase, 'failed'), phase).toBe(false)
    }
    expect(proposalsReadable('done', 'registered')).toBe(true)
  })

  it('reads at once for a vault opened from this device or in a signing session', () => {
    expect(proposalsReadable('restored', 'idle')).toBe(true)
    expect(proposalsReadable('signsession', 'idle')).toBe(true)
  })

  it('is what NetVault asks before it loads the proposals', () => {
    const code = codeAt(new URL('./screens/NetVault.tsx', import.meta.url).pathname)
    expect(code).toMatch(/helperConfigured\(\) && groupVk && proposalsReadable\(phase, hostedState\)\) void loadProposals\(\)/)
  })
})
