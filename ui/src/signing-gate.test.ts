import { describe, expect, it } from 'vitest'
import { ARM_TTL_MS, armIsLive, makeSigningGate, type SigningMode } from './signing-gate'

// The governance policy for background signing (#49): a device never signs an unapproved payment;
// beyond that, auto signs approved ones on its own, manual also needs the owner to arm the payment.
describe('makeSigningGate - auto/manual signing policy', () => {
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

// Consent should not outlive the act that gave it: a device left open on a signed payment must not
// contribute its share to a request that turns up hours later, with nobody watching.
describe('armIsLive - an arming has a deadline', () => {
  const t0 = 1_700_000_000_000

  it('is not live before the owner signs', () => {
    expect(armIsLive(null, t0)).toBe(false)
  })

  it('is live for the whole window, and not one moment past it', () => {
    expect(armIsLive(t0, t0)).toBe(true)
    expect(armIsLive(t0, t0 + ARM_TTL_MS)).toBe(true)
    expect(armIsLive(t0, t0 + ARM_TTL_MS + 1)).toBe(false)
  })

  it('covers a whole legitimate ceremony: build and prove, then the wait for the shares', () => {
    expect(armIsLive(t0, t0 + 2 * 60 * 1000 + 5 * 60 * 1000)).toBe(true)
  })

  it('reads a backwards clock jump as not armed, never as armed forever', () => {
    expect(armIsLive(t0, t0 - 1000)).toBe(false)
  })
})
