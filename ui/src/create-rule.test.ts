import { describe, expect, it } from 'vitest'
import { CREATE_DEVICE_CAP, noMarginWarning, recommendedRule } from './create-rule'
import { quorumIsPossible } from './dkg-ceremony'
import { codeOf } from './source-scan'

// #839: with 5 of 5 on the create screen, the no-margin warning recommended "5 de 6", a rule
// the screen cannot create (its device stepper stops at 5). What it recommends has to be a rule the
// same screen can make, read from the same cap.
const en = (_pt: string, e: string) => e
const pt = (p: string) => p

describe('creating a vault: the no-margin warning only recommends a rule the screen can create', () => {
  it('at the device cap, it recommends one signature fewer, not one device more', () => {
    expect(noMarginWarning(5, pt)).toBe(
      'Se um aparelho for perdido e o backup dele também, os fundos ficam presos, sem como recuperar. Recomendamos 4 de 5.',
    )
    expect(noMarginWarning(5, en)).toBe(
      'If one device is lost and its backup too, the funds are locked, with no way to recover. We recommend 4 of 5.',
    )
  })

  // #1049: a member's backup restores their seat on a new device (docs/RECOVERY.md, procedure A), so
  // losing a device alone does not lock the funds. The warning names what does: the device AND its backup.
  it('names losing the device and its backup, not the device alone, as what locks the funds', () => {
    expect(noMarginWarning(3, en)).toMatch(/^If one device is lost and its backup too, /)
    expect(noMarginWarning(3, pt)).toMatch(/^Se um aparelho for perdido e o backup dele também, /)
  })

  it('below the cap, it still recommends one device more', () => {
    expect(noMarginWarning(2, pt)).toContain('Recomendamos 2 de 3.')
    expect(noMarginWarning(4, en)).toContain('We recommend 4 of 5.')
  })

  it('for every t-of-t the screen offers, the recommendation is creatable and leaves a margin', () => {
    for (let t = 2; t <= CREATE_DEVICE_CAP; t++) {
      const r = recommendedRule(t)
      expect(r.n).toBeLessThanOrEqual(CREATE_DEVICE_CAP)
      expect(r.t).toBeLessThan(r.n)
      expect(quorumIsPossible(r.t, r.n)).toBe(true)
    }
  })

  it('the stepper reads the same cap: no second number on the screen', () => {
    const screen = codeOf('screens/NetVault.tsx')
    expect(screen).toContain('disabled={n >= CREATE_DEVICE_CAP}')
    expect(screen).not.toMatch(/\bn\s*>=\s*\d/)
    expect(screen).not.toMatch(/Recomendamos \$\{|We recommend \$\{/)
  })
})
