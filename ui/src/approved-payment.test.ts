/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { gateDecision, matchesApprovedPayment, ourReceiversFrom, paysOurselves, type ApprovedLine, type PcztOutput } from './approved-payment'
import { codeOf } from './source-scan'

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
  { address: rcv === ALICE_RCV ? ALICE_UA : null, value: zat, recipient: rcv, memo: '' },
  { address: null, value: change, recipient: VAULT_CHG, memo: '' }, // change: internal scope, no user_address
  { address: null, value: 0, recipient: VAULT_CHG, memo: '' }, // dummy padding
]
const line = (rcv: string, amountZat: number, memo = ''): ApprovedLine => ({ toReceiver: rcv, amountZat, memo })

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
      { address: ALICE_UA, value: 1_200_000, recipient: ALICE_RCV, memo: '' },
      { address: null, value: 50_000, recipient: MALLORY_RCV, memo: '' }, // the skim (no user_address)
      { address: null, value: 900_000, recipient: VAULT_CHG, memo: '' },
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  it('ignores change (external OR internal scope) and zero-value dummies', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_200_000, recipient: ALICE_RCV, memo: '' },
      { address: null, value: 3_400_000, recipient: VAULT_CHG, memo: '' }, // internal change, any amount
      { address: null, value: 1_000, recipient: VAULT_EXT, memo: '' }, // paying our own external addr is still ours
      { address: null, value: 0, recipient: VAULT_CHG, memo: '' },
      { address: null, value: 0, recipient: ALICE_RCV, memo: '' }, // a zero-value output is a dummy, not a payment
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
      { address: ALICE_UA, value: 1_200_000, recipient: ALICE_RCV, memo: '' },
      { address: null, value: 300_000, recipient: MALLORY_RCV, memo: '' }, // dressed as change, actually a skim
      { address: null, value: 600_000, recipient: VAULT_CHG, memo: '' }, // the real change
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  // A hostile helper labels the attacker's output with the VICTIM's user_address, hoping a
  // label-based check waves it through. The money follows `recipient`, not the label, so the
  // decision must too.
  it('REFUSES an output whose user_address lies (label says Alice, recipient is Mallory)', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_200_000, recipient: MALLORY_RCV, memo: '' }, // spoofed label
      { address: null, value: 999_500, recipient: VAULT_CHG, memo: '' },
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  // The converse: an honest send is accepted even though its change carries no user_address at all.
  it('accepts a real send whose change output has no user_address', () => {
    const realSend: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: '' },
      { address: null, value: 999_600, recipient: VAULT_CHG, memo: '' },
      { address: null, value: 0, recipient: VAULT_CHG, memo: '' },
    ]
    expect(matchesApprovedPayment(realSend, [line(ALICE_RCV, 1_000_000)], OURS)).toBe(true)
  })
})

describe('matchesApprovedPayment — payroll (N lines)', () => {
  const outs = (): PcztOutput[] => [
    { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: '' },
    { address: 'u1bob', value: 2_000_000, recipient: BOB_RCV, memo: '' },
    { address: null, value: 500_000, recipient: VAULT_CHG, memo: '' },
  ]
  const approved = [line(ALICE_RCV, 1_000_000), line(BOB_RCV, 2_000_000)]

  it('accepts a payroll paying exactly its lines', () => {
    expect(matchesApprovedPayment(outs(), approved, OURS)).toBe(true)
  })

  it('REFUSES a payroll missing a beneficiary', () => {
    const missing: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: '' },
      { address: null, value: 500_000, recipient: VAULT_CHG, memo: '' },
    ]
    expect(matchesApprovedPayment(missing, approved, OURS)).toBe(false)
  })

  it('REFUSES a payroll where one beneficiary was swapped', () => {
    const swapped: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: '' },
      { address: null, value: 2_000_000, recipient: MALLORY_RCV, memo: '' },
      { address: null, value: 500_000, recipient: VAULT_CHG, memo: '' },
    ]
    expect(matchesApprovedPayment(swapped, approved, OURS)).toBe(false)
  })

  it('handles the same address paid twice (two lines, two outputs)', () => {
    const twice: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: '' },
      { address: ALICE_UA, value: 2_000_000, recipient: ALICE_RCV, memo: '' },
      { address: null, value: 500_000, recipient: VAULT_CHG, memo: '' },
    ]
    const two = [line(ALICE_RCV, 1_000_000), line(ALICE_RCV, 2_000_000)]
    expect(matchesApprovedPayment(twice, two, OURS)).toBe(true)
  })
})

// #610. The memo travels inside the encrypted note, which the signature covers, and the device now
// opens each paying output and reads it. A payslip's text is part of what the group approved.
describe('matchesApprovedPayment — memos', () => {
  const withMemo = (memo: string | null): PcztOutput[] => [
    { address: ALICE_UA, value: 1_200_000, recipient: ALICE_RCV, memo },
    { address: null, value: 999_500, recipient: VAULT_CHG, memo: '' },
  ]

  it('accepts a payment whose memo is the approved one', () => {
    expect(matchesApprovedPayment(withMemo('March salary'), [line(ALICE_RCV, 1_200_000, 'March salary')], OURS)).toBe(true)
  })

  it('accepts an empty memo where none was approved', () => {
    expect(matchesApprovedPayment(withMemo(''), [line(ALICE_RCV, 1_200_000)], OURS)).toBe(true)
  })

  it('REFUSES a payment whose memo differs from the approved one', () => {
    expect(matchesApprovedPayment(withMemo('pay to the order of Mallory'), [line(ALICE_RCV, 1_200_000, 'March salary')], OURS)).toBe(false)
  })

  it('REFUSES a memo added where none was approved', () => {
    expect(matchesApprovedPayment(withMemo('surprise'), [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  it('REFUSES a memo that is not text (null), whatever was approved', () => {
    expect(matchesApprovedPayment(withMemo(null), [line(ALICE_RCV, 1_200_000)], OURS)).toBe(false)
  })

  it('REFUSES a payroll whose two payslips were swapped between beneficiaries', () => {
    const swapped: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: 'Bob, March' },
      { address: 'u1bob', value: 2_000_000, recipient: BOB_RCV, memo: 'Alice, March' },
      { address: null, value: 500_000, recipient: VAULT_CHG, memo: '' },
    ]
    const approved = [line(ALICE_RCV, 1_000_000, 'Alice, March'), line(BOB_RCV, 2_000_000, 'Bob, March')]
    expect(matchesApprovedPayment(swapped, approved, OURS)).toBe(false)
  })

  it('pairs two payments to one address by their memos', () => {
    const twice: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: 'bonus' },
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: 'salary' },
      { address: null, value: 500_000, recipient: VAULT_CHG, memo: '' },
    ]
    const two = [line(ALICE_RCV, 1_000_000, 'salary'), line(ALICE_RCV, 1_000_000, 'bonus')]
    expect(matchesApprovedPayment(twice, two, OURS)).toBe(true)
  })
})

// The vault's own receivers decide what the gate ignores as change, so they must come from what this
// device recorded, never from what the coordinator answers when the device signs. The gate used to
// decode `vault.orchard_address`, which `getVault` took from the coordinator on every load until A9: a
// coordinator that answered with its own address could pay the approved lines exactly and send the
// rest of the spent notes to itself, and the gate read that as the vault's change.
describe('ourReceiversFrom', () => {
  const decode = (ua: string) => `rcv(${ua})`

  it('takes both receivers from the device record', () => {
    expect(ourReceiversFrom({ address: 'u1vault', changeReceiver: 'u1change' }, decode)).toEqual(['rcv(u1vault)', 'rcv(u1change)'])
  })

  it('refuses to answer when either is missing, so the gate refuses rather than guesses', () => {
    expect(ourReceiversFrom({ address: 'u1vault' }, decode)).toBeNull()
    expect(ourReceiversFrom({ address: ' ', changeReceiver: 'u1change' }, decode)).toBeNull()
    expect(ourReceiversFrom(undefined, decode)).toBeNull()
  })

  it('treats a value that is not text as missing, the way every other reader of the address does', () => {
    // A record written by an older import, or a corrupt one: refuse, never throw (A9).
    expect(ourReceiversFrom({ address: 123, changeReceiver: 'u1change' }, decode)).toBeNull()
    expect(ourReceiversFrom({ address: 'u1vault', changeReceiver: { x: 1 } }, decode)).toBeNull()
  })

  it('is the only way the signer builds them, and it never reads the address the coordinator serves', () => {
    const src = codeOf('./VaultSigner.tsx')
    expect(src).toContain('ourReceiversFrom(')
    expect(src).not.toMatch(/\borchard_address\b/)
  })
})

// What the gate answers, and why: a refusal because this device could not work out what was approved
// is worded differently from a payment that does not match it (#610 review). The machine words each
// answer (signing-machine.test.ts); the decision that tells them apart is this pure function.
describe('gateDecision', () => {
  const ctx = { approved: [line(ALICE_RCV, 1_200_000)], ourReceivers: OURS }
  it('matches what was approved', () => {
    expect(gateDecision(ctx, payTo(ALICE_RCV, 1_200_000))).toBe('match')
  })
  it('says a different payment does not match', () => {
    expect(gateDecision(ctx, payTo(MALLORY_RCV, 1_200_000))).toBe('mismatch')
  })
  it('says it does not know when nothing was worked out', () => {
    expect(gateDecision(null, payTo(ALICE_RCV, 1_200_000))).toBe('unknown')
  })
})

// The signing screen calls an unlabelled output the vault's change only when this says so (#610).
describe('paysOurselves', () => {
  it('knows the vault\'s own receivers, in any case or padding', () => {
    expect(paysOurselves(OURS[1]!, OURS)).toBe(true)
    expect(paysOurselves(` ${OURS[0]!.toUpperCase()} `, OURS)).toBe(true)
  })
  it('calls nothing its own that is not', () => {
    expect(paysOurselves(MALLORY_RCV, OURS)).toBe(false)
    expect(paysOurselves(null, OURS)).toBe(false)
  })
  it('calls nothing its own before the receivers are known', () => {
    expect(paysOurselves(OURS[1]!, null)).toBe(false)
    expect(paysOurselves(OURS[1]!, [])).toBe(false)
  })
})

describe('matchesApprovedPayment — fail closed', () => {
  it('refuses when nothing was approved', () => {
    expect(matchesApprovedPayment(payTo(ALICE_RCV, 1_000_000), [], OURS)).toBe(false)
  })

  it('refuses a positive-value output with an unreadable (null) recipient', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ALICE_RCV, memo: '' },
      { address: null, value: 7_000_000, recipient: null, memo: '' }, // unverifiable → must refuse
      { address: null, value: 500_000, recipient: VAULT_CHG, memo: '' },
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_000_000)], OURS)).toBe(false)
  })

  it('tolerates case/whitespace on receiver hex', () => {
    const outs: PcztOutput[] = [
      { address: ALICE_UA, value: 1_000_000, recipient: ` ${ALICE_RCV.toUpperCase()} `, memo: '' },
      { address: null, value: 500_000, recipient: VAULT_CHG, memo: '' },
    ]
    expect(matchesApprovedPayment(outs, [line(ALICE_RCV, 1_000_000)], OURS)).toBe(true)
  })
})
