import { describe, expect, it } from 'vitest'
import { matchesApprovedPayment, type PcztOutput } from './approved-payment'

const VAULT = 'u1vaultownaddress'
const ALICE = 'u1alice_recipient'
const BOB = 'u1bob_recipient'
const MALLORY = 'u1mallory_attacker'

// A realistic single payment: recipient + change back to the vault + a zero-value dummy.
const payTo = (addr: string, zat: number, change = 500): PcztOutput[] => [
  { address: addr, value: zat },
  { address: VAULT, value: change },
  { address: VAULT, value: 0 },
]

describe('matchesApprovedPayment — single payment', () => {
  it('accepts the exact approved payment', () => {
    expect(matchesApprovedPayment(payTo(ALICE, 1_200_000), [{ to: ALICE, amountZat: 1_200_000 }], VAULT)).toBe(true)
  })

  it('REFUSES a swapped recipient (same amount, different address)', () => {
    expect(matchesApprovedPayment(payTo(MALLORY, 1_200_000), [{ to: ALICE, amountZat: 1_200_000 }], VAULT)).toBe(false)
  })

  it('REFUSES a swapped amount (same recipient, more money)', () => {
    expect(matchesApprovedPayment(payTo(ALICE, 9_900_000), [{ to: ALICE, amountZat: 1_200_000 }], VAULT)).toBe(false)
  })

  it('REFUSES a skim: pays the approved recipient AND an extra external output', () => {
    const outs: PcztOutput[] = [
      { address: ALICE, value: 1_200_000 },
      { address: MALLORY, value: 50_000 }, // the skim
      { address: VAULT, value: 500 },
    ]
    expect(matchesApprovedPayment(outs, [{ to: ALICE, amountZat: 1_200_000 }], VAULT)).toBe(false)
  })

  it('ignores change back to the vault and zero-value dummies', () => {
    const outs: PcztOutput[] = [
      { address: ALICE, value: 1_200_000 },
      { address: VAULT, value: 3_400_000 }, // change, any amount
      { address: VAULT, value: 0 },
      { address: ALICE, value: 0 }, // a zero-value output is a dummy, not a second payment
    ]
    expect(matchesApprovedPayment(outs, [{ to: ALICE, amountZat: 1_200_000 }], VAULT)).toBe(true)
  })
})

describe('matchesApprovedPayment — payroll (N lines)', () => {
  const outs = (): PcztOutput[] => [
    { address: ALICE, value: 1_000_000 },
    { address: BOB, value: 2_000_000 },
    { address: VAULT, value: 500 },
  ]
  const approved = [
    { to: ALICE, amountZat: 1_000_000 },
    { to: BOB, amountZat: 2_000_000 },
  ]

  it('accepts a payroll paying exactly its lines', () => {
    expect(matchesApprovedPayment(outs(), approved, VAULT)).toBe(true)
  })

  it('REFUSES a payroll missing a beneficiary', () => {
    const missing: PcztOutput[] = [{ address: ALICE, value: 1_000_000 }, { address: VAULT, value: 500 }]
    expect(matchesApprovedPayment(missing, approved, VAULT)).toBe(false)
  })

  it('REFUSES a payroll where one beneficiary was swapped', () => {
    const swapped: PcztOutput[] = [
      { address: ALICE, value: 1_000_000 },
      { address: MALLORY, value: 2_000_000 },
      { address: VAULT, value: 500 },
    ]
    expect(matchesApprovedPayment(swapped, approved, VAULT)).toBe(false)
  })

  it('handles the same address paid twice (two lines, two outputs)', () => {
    const twice: PcztOutput[] = [
      { address: ALICE, value: 1_000_000 },
      { address: ALICE, value: 2_000_000 },
      { address: VAULT, value: 500 },
    ]
    const two = [
      { to: ALICE, amountZat: 1_000_000 },
      { to: ALICE, amountZat: 2_000_000 },
    ]
    expect(matchesApprovedPayment(twice, two, VAULT)).toBe(true)
  })
})

describe('matchesApprovedPayment — fail closed', () => {
  it('refuses when nothing was approved', () => {
    expect(matchesApprovedPayment(payTo(ALICE, 1_000_000), [], VAULT)).toBe(false)
  })

  it('refuses a positive-value output with an unreadable (null) address', () => {
    const outs: PcztOutput[] = [
      { address: ALICE, value: 1_000_000 },
      { address: null, value: 7_000_000 }, // unverifiable → must refuse
      { address: VAULT, value: 500 },
    ]
    expect(matchesApprovedPayment(outs, [{ to: ALICE, amountZat: 1_000_000 }], VAULT)).toBe(false)
  })

  it('tolerates trailing/leading whitespace on addresses', () => {
    const outs: PcztOutput[] = [{ address: ` ${ALICE} `, value: 1_000_000 }, { address: VAULT, value: 500 }]
    expect(matchesApprovedPayment(outs, [{ to: ALICE, amountZat: 1_000_000 }], VAULT)).toBe(true)
  })
})
