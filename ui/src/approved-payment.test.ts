import { describe, expect, it } from 'vitest'
import { matchesApprovedPayment, type ApprovedLine, type PcztOutput } from './approved-payment'

// Receivers as the device reads them: raw 43-byte Orchard/Ironwood addresses, hex. Short distinct
// tokens here - the matcher compares the bytes, it does not parse them.
const ALICE_RCV = 'a1a1a1a1'
const BOB_RCV = 'b0b0b0b0'
const MALLORY_RCV = 'cacacaca'
const VAULT_EXT = 'de010101' // the vault's external receive receiver
const VAULT_CHG = 'de020202' // the vault's INTERNAL change receiver (where real change lands)
const OURS = [VAULT_EXT, VAULT_CHG]

// User-facing UA labels (user_address). Advisory only; the matcher must ignore them.
const ALICE_UA = 'u1alice_recipient'

// A realistic single payment: recipient + change to the vault's INTERNAL scope (no user_address) +
// a zero-value dummy. This is the shape decoded from a real mainnet Ironwood send.
const payTo = (rcv: string, zat: number, change = 999_500): PcztOutput[] => [
  { address: rcv === ALICE_RCV ? ALICE_UA : null, value: zat, recipient: rcv },
  { address: null, value: change, recipient: VAULT_CHG }, // change: internal scope, no user_address
  { address: null, value: 0, recipient: VAULT_CHG }, // dummy padding
]
const line = (rcv: string, amountZat: number): ApprovedLine => ({ toReceiver: rcv, amountZat })

describe('matchesApprovedPayment — single payment', () => {
  it('accepts the exact approved payment (with real internal-scope change)', () => {
    expect(matchesApprovedPayment(payTo(ALICE_RCV, 1_200_000), [line(ALICE_RCV, 1_200_000)], OURS)).toBe(true)
  })

  it('REFUSES a swapped recipient (same amount, different receiver)', () => {
    expect(matchesApprovedPayment(payTo(MALLORY_RCV, 1_200_000), [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  it('REFUSES a swapped amount (same recipient, more money)', () => {
    expect(matchesApprovedPayment(payTo(ALICE_RCV, 9_900_000), [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  it('REFUSES a skim: pays the approved recipient AND an extra external output', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_200_000, recipient: ALICE_RCV },
      { address: null, value: 50_000, recipient: MALLORY_RCV }, // the skim (no user_address)
      { address: null, value: 900_000, recipient: VAULT_CHG },
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  it('ignores change (external OR internal scope) and zero-value dummies', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_200_000, recipient: ALICE_RCV },
      { address: null, value: 3_400_000, recipient: VAULT_CHG }, // internal change, any amount
      { address: null, value: 1_000, recipient: VAULT_EXT }, // paying our own external addr is still ours
      { address: null, value: 0, recipient: VAULT_CHG },
      { address: null, value: 0, recipient: ALICE_RCV }, // a zero-value output is a dummy, not a payment
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_200_000)], OURS)).toBe(true)
  })
})

describe('matchesApprovedPayment — the attacks the user_address label could not catch', () => {
  // A skim the helper hides AS change: it drops the user_address so the output looks like change.
  // The (address, value) shape saw {address: null, value > 0} and could only fail-closed (brick
  // every real send) or fail-open (allow this skim). Recipient bytes tell them apart: Mallory's
  // receiver is not one of ours → external → no approved line → refuse. THIS is why #281 moved to
  // recipient bytes.
  it('REFUSES a skim disguised as change (no user_address, recipient is the attacker)', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_200_000, recipient: ALICE_RCV },
      { address: null, value: 300_000, recipient: MALLORY_RCV }, // dressed as change, actually a skim
      { address: null, value: 600_000, recipient: VAULT_CHG }, // the real change
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  // A hostile helper labels the attacker's output with the VICTIM's user_address, hoping a
  // label-based check waves it through. The money follows `recipient`, not the label, so the
  // decision must too.
  it('REFUSES an output whose user_address lies (label says Alice, recipient is Mallory)', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_200_000, recipient: MALLORY_RCV }, // spoofed label
      { address: null, value: 999_500, recipient: VAULT_CHG },
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  // The converse: an honest send is accepted even though its change carries no user_address at all.
  it('accepts a real send whose change output has no user_address', () => {
    const realSend: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV },
      { address: null, value: 999_600, recipient: VAULT_CHG },
      { address: null, value: 0, recipient: VAULT_CHG },
    ]
    expect(matchesApprovedPayment(realSend, [line(ALICE_RCV, 1_000_000)], OURS)).toBe(true)
  })
})

describe('matchesApprovedPayment — payroll (N lines)', () => {
  const outs = (): PcztOutput[] => [
    { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV },
    { address: 'u1bob', value: 2_000_000, recipient: BOB_RCV },
    { address: null, value: 500_000, recipient: VAULT_CHG },
  ]
  const approved = [line(ALICE_RCV, 1_000_000), line(BOB_RCV, 2_000_000)]

  it('accepts a payroll paying exactly its lines', () => {
    expect(matchesApprovedPayment(outs(), approved, OURS)).toBe(true)
  })

  it('REFUSES a payroll missing a beneficiary', () => {
    const missing: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV },
      { address: null, value: 500_000, recipient: VAULT_CHG },
    ]
    expect(matchesApprovedPayment(missing, approved, OURS)).toBe(false)
  })

  it('REFUSES a payroll where one beneficiary was swapped', () => {
    const swapped: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV },
      { address: null, value: 2_000_000, recipient: MALLORY_RCV },
      { address: null, value: 500_000, recipient: VAULT_CHG },
    ]
    expect(matchesApprovedPayment(swapped, approved, OURS)).toBe(false)
  })

  it('handles the same address paid twice (two lines, two outputs)', () => {
    const twice: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV },
      { address: ALICE_UA, value: 2_000_000, recipient: ALICE_RCV },
      { address: null, value: 500_000, recipient: VAULT_CHG },
    ]
    const two = [line(ALICE_RCV, 1_000_000), line(ALICE_RCV, 2_000_000)]
    expect(matchesApprovedPayment(twice, two, OURS)).toBe(true)
  })
})

describe('matchesApprovedPayment — fail closed', () => {
  it('refuses when nothing was approved', () => {
    expect(matchesApprovedPayment(payTo(ALICE_RCV, 1_000_000), [], OURS)).toBe(false)
  })

  it('refuses a positive-value output with an unreadable (null) recipient', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV },
      { address: null, value: 7_000_000, recipient: null }, // unverifiable → must refuse
      { address: null, value: 500_000, recipient: VAULT_CHG },
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_000_000)], OURS)).toBe(false)
  })

  it('tolerates case/whitespace on receiver hex', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ` ${ALICE_RCV.toUpperCase()} ` },
      { address: null, value: 500_000, recipient: VAULT_CHG },
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_000_000)], OURS)).toBe(true)
  })
})
