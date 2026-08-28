import { describe, expect, it } from 'vitest'
import { approvalGateDecision, type ApprovalContext } from './approval-gate'
import type { PcztOutput } from './approved-payment'

// Receivers (raw address bytes, hex) - what the device compares. Labels are advisory.
const ALICE_RCV = 'a1a1a1a1'
const MALLORY_RCV = 'cacacaca'
const VAULT_CHG = 'de020202'
const OURS = [VAULT_CHG]

// The owner approved and armed a payment of 1,200,000 zat to Alice.
const armedForAlice: ApprovalContext = {
  approved: [{ toReceiver: ALICE_RCV, amountZat: 1_200_000 }],
  ourReceivers: OURS,
  mode: 'manual',
  armedAndLive: true,
}

const paysAlice: { outputs: PcztOutput[] } = {
  outputs: [
    { address: 'u1alice', value: 1_200_000, recipient: ALICE_RCV },
    { address: null, value: 999_500, recipient: VAULT_CHG },
  ],
}
const paysMallory: { outputs: PcztOutput[] } = {
  outputs: [
    { address: 'u1alice', value: 1_200_000, recipient: MALLORY_RCV }, // label lies; recipient is Mallory
    { address: null, value: 999_500, recipient: VAULT_CHG },
  ],
}

describe('approvalGateDecision — the money-gate business rule (#281)', () => {
  it('signs the approved payment when the owner armed it', () => {
    expect(approvalGateDecision(armedForAlice, paysAlice)).toBe(true)
  })

  // THE RULE THAT MATTERS: a device armed for Alice must REFUSE a request that pays Mallory,
  // even though the owner armed *a* proposal. Approval must bind to the payment, not to arming.
  it('REFUSES a swapped payment even while armed (a hostile coordinator swaps the destination)', () => {
    expect(approvalGateDecision(armedForAlice, paysMallory)).toBe(false)
  })

  it('REFUSES a swapped amount even while armed', () => {
    const paysAliceMore = {
      outputs: [
        { address: 'u1alice', value: 9_000_000, recipient: ALICE_RCV },
        { address: null, value: 999_500, recipient: VAULT_CHG },
      ],
    }
    expect(approvalGateDecision(armedForAlice, paysAliceMore)).toBe(false)
  })

  it('does not sign the approved payment when NOT armed (manual mode)', () => {
    expect(approvalGateDecision({ ...armedForAlice, armedAndLive: false }, paysAlice)).toBe(false)
  })

  it('auto mode signs the approved payment with no arming, but still refuses a swap', () => {
    const auto: ApprovalContext = { ...armedForAlice, mode: 'auto', armedAndLive: false }
    expect(approvalGateDecision(auto, paysAlice)).toBe(true)
    expect(approvalGateDecision(auto, paysMallory)).toBe(false)
  })
})
