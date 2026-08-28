import { describe, expect, it } from 'vitest'
import { approvalGateDecision, type ApprovalContext } from './approval-gate'
import type { PcztOutput } from './approved-payment'

const VAULT = 'u1vault'
const ALICE = 'u1alice'
const MALLORY = 'u1mallory'

// The owner approved and armed a payment of 1,200,000 zat to Alice.
const armedForAlice: ApprovalContext = {
  approved: [{ to: ALICE, amountZat: 1_200_000 }],
  vaultAddress: VAULT,
  mode: 'manual',
  armedAndLive: true,
}

const paysAlice: { outputs: PcztOutput[] } = {
  outputs: [{ address: ALICE, value: 1_200_000 }, { address: VAULT, value: 500 }],
}
const paysMallory: { outputs: PcztOutput[] } = {
  outputs: [{ address: MALLORY, value: 1_200_000 }, { address: VAULT, value: 500 }],
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
    const paysAliceMore = { outputs: [{ address: ALICE, value: 9_000_000 }, { address: VAULT, value: 500 }] }
    expect(approvalGateDecision(armedForAlice, paysAliceMore)).toBe(false)
  })

  it('does not sign the approved payment when NOT armed (manual mode)', () => {
    expect(approvalGateDecision({ ...armedForAlice, armedAndLive: false }, paysAlice)).toBe(false)
  })
})
