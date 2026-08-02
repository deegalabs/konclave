import { describe, expect, it } from 'vitest'
import { makeSigningGate, type SigningMode } from './signing-gate'

// The governance policy for background signing (#49): a device never signs an unapproved payment;
// beyond that, auto signs approved ones on its own, manual also needs the owner to arm the payment.
describe('makeSigningGate — auto/manual signing policy', () => {
  const SH = 'deadbeef'

  it('never signs an unapproved payment, in either mode', async () => {
    for (const mode of ['auto', 'manual'] as SigningMode[]) {
      const gate = makeSigningGate({ mode: () => mode, isApproved: () => false, isArmed: () => true })
      expect(await gate({ sighash: SH })).toBe(false)
    }
  })

  it('auto: signs an approved payment automatically (no arming needed)', async () => {
    const gate = makeSigningGate({ mode: () => 'auto', isApproved: () => true, isArmed: () => false })
    expect(await gate({ sighash: SH })).toBe(true)
  })

  it('manual: an approved payment waits until the owner arms it', async () => {
    let armed = false
    const gate = makeSigningGate({ mode: () => 'manual', isApproved: () => true, isArmed: () => armed })
    expect(await gate({ sighash: SH })).toBe(false) // approved but not armed -> pending
    armed = true
    expect(await gate({ sighash: SH })).toBe(true) // owner armed it -> signs
  })

  it('reads the mode live, so a governance change takes effect on the next check', async () => {
    let mode: SigningMode = 'manual'
    const gate = makeSigningGate({ mode: () => mode, isApproved: () => true, isArmed: () => false })
    expect(await gate({ sighash: SH })).toBe(false) // manual, unarmed
    mode = 'auto' // a proposal flipped the vault to auto
    expect(await gate({ sighash: SH })).toBe(true)
  })

  it('arms per-payment (sighash), not globally', async () => {
    const armedSet = new Set<string>(['aaaa'])
    const gate = makeSigningGate({ mode: () => 'manual', isApproved: () => true, isArmed: (sh) => armedSet.has(sh) })
    expect(await gate({ sighash: 'aaaa' })).toBe(true)
    expect(await gate({ sighash: 'bbbb' })).toBe(false)
  })
})
