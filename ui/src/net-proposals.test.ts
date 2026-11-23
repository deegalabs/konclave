import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codeAt } from './source-scan'
import { proposalsReadable } from './net-proposals'

// The /net screen reads a vault's proposals only once the coordinator knows the vault. During a
// creation that is after the registration (every new member got a 404 before); a vault opened from
// this device (restored) shows no proposals on this page, so it reads none.
describe('proposalsReadable', () => {
  it('waits for the registration during a creation', () => {
    for (const phase of ['idle', 'roster', 'confirm', 'dkg', 'done', 'error'] as const) {
      expect(proposalsReadable(phase, 'idle'), phase).toBe(false)
      expect(proposalsReadable(phase, 'registering'), phase).toBe(false)
      expect(proposalsReadable(phase, 'failed'), phase).toBe(false)
    }
    expect(proposalsReadable('done', 'registered')).toBe(true)
  })

  it('reads nothing for a vault opened from this device: the page shows no proposals there', () => {
    expect(proposalsReadable('restored', 'idle')).toBe(false)
    expect(proposalsReadable('restored', 'registered')).toBe(false)
  })

  it('is what NetVault asks before it loads the proposals', () => {
    const code = codeAt(fileURLToPath(new URL('./screens/NetVault.tsx', import.meta.url)))
    expect(code).toMatch(/helperConfigured\(\) && groupVk && proposalsReadable\(phase, hostedState\)\) void loadProposals\(\)/)
  })
})
