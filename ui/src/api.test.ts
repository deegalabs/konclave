import { describe, expect, it } from 'vitest'
import { shortAddr, classifyAddress, humanError, netState, mapNetProposal } from './api'
import type { Proposal as NetProposal } from './helper'
import type { TFn } from './i18n'

// Fake translator: returns the key so we can assert which message humanError picked.
const t: TFn = (key) => key

describe('shortAddr', () => {
  it('elides the middle of a long address', () => {
    const a = 'u1vjgxlvz4ewnt43rkq6fzexpld406dr'
    expect(shortAddr(a)).toBe('u1vjgx…d406dr')
  })
  it('leaves short strings untouched', () => {
    expect(shortAddr('u1abc')).toBe('u1abc')
  })
})

describe('classifyAddress (mirrors the backend prefix heuristic)', () => {
  it('classifies by prefix', () => {
    expect(classifyAddress('u1abc')).toBe('unified')
    expect(classifyAddress('zs1abc')).toBe('sapling')
    expect(classifyAddress('t1abc')).toBe('transparent')
    expect(classifyAddress('t3abc')).toBe('transparent')
    expect(classifyAddress('nope')).toBe('unknown')
  })
})

describe('humanError (technical code → i18n message, §6.11)', () => {
  it('maps known backend codes to human keys', () => {
    expect(humanError(t, 'insufficient funds')).toBe('error.insufficient')
    expect(humanError(t, 'send failed')).toBe('error.ceremony')
    expect(humanError(t, 'invalid address')).toBe('error.invalidAddress')
    expect(humanError(t, 'no vault')).toBe('error.noVault')
    expect(humanError(t, 'expired')).toBe('error.expired')
    expect(humanError(t, 'no connection')).toBe('error.noConnection')
  })
  it('matches on detail substrings too', () => {
    expect(humanError(t, 'x', 'frostd transport refused')).toBe('error.ceremony')
    expect(humanError(t, 'x', 'apply_signature failed')).toBe('error.share')
  })
  it('falls back to a short readable detail, else a generic message', () => {
    expect(humanError(t, 'weird', 'a concise readable reason')).toBe('a concise readable reason')
    expect(humanError(t, undefined, undefined)).toBe('error.unexpected')
    const huge = 'x'.repeat(200)
    expect(humanError(t, huge, huge)).toBe('error.unexpected')
  })
})

describe('NET adapter (helper proposal -> PWA proposal)', () => {
  it('remaps helper states to PWA states', () => {
    expect(netState('pending')).toBe('awaiting')
    expect(netState('refused')).toBe('rejected')
    expect(netState('ready')).toBe('ready')
    expect(netState('sent')).toBe('sent')
    expect(netState('expired')).toBe('expired')
  })

  it('maps a helper payment proposal onto the PWA shape', () => {
    const hp: NetProposal = {
      id: 'p1',
      vault_id: 'v1',
      kind: 'payment',
      to: 'u1recipient',
      amount_zat: 5_000_000,
      memo: null,
      proposer: 'Alice',
      state: 'pending',
      approvals: ['Alice'],
      refusals: [],
      threshold: 2,
      total: 3,
      created_at_unix: 1_700_000_000,
      expiry_unix: 1_700_100_000,
      txid: null,
    }
    const p = mapNetProposal(hp)
    expect(p.id).toBe('p1')
    expect(p.kind).toBe('payment')
    expect(p.state).toBe('awaiting') // pending -> awaiting
    expect(p.value_zat).toBe(5_000_000)
    expect(p.to_address).toBe('u1recipient')
    expect(p.is_public).toBe(false) // unified address is shielded
    expect(p.memo).toBeUndefined() // null -> undefined
    expect(p.approvals_count).toBe(1)
    expect(p.txid).toBeUndefined()
  })

  it('flags a transparent destination as public and carries a txid', () => {
    const hp: NetProposal = {
      id: 'p2', vault_id: 'v1', kind: 'payment', to: 't1transparent', amount_zat: 1000,
      memo: 'rent', proposer: 'Bob', state: 'sent', approvals: ['Alice', 'Bob'], refusals: [],
      threshold: 2, total: 3, created_at_unix: 1, expiry_unix: 0, txid: 'abc123',
    }
    const p = mapNetProposal(hp)
    expect(p.is_public).toBe(true) // transparent -> public
    expect(p.state).toBe('sent')
    expect(p.memo).toBe('rent')
    expect(p.txid).toBe('abc123')
    expect(p.approvals_count).toBe(2)
  })
})

// The money path must never show a binary path and a Rust struct. This one shipped to a user:
//   /usr/local/bin/konclave-signer exited with 1: Error: propose_transfer:
//   InsufficientFunds { available: Zatoshis(20000), required: Zatoshis(24000) }
describe('humanError - insufficient funds carries the two figures that decide it', () => {
  const t = ((k: string, v?: Record<string, string | number>) =>
    k === 'error.insufficientExact' ? `have ${v?.have} need ${v?.need}` : k) as unknown as Parameters<typeof humanError>[0]

  it('reads the engine figures out of the raw error and formats them as ZEC', () => {
    const raw = '/usr/local/bin/konclave-signer exited with 1: Error: propose_transfer: '
      + 'InsufficientFunds { available: Zatoshis(20000), required: Zatoshis(24000) }'
    expect(humanError(t, raw)).toBe('have 0.0002 need 0.00024')
  })

  it('reads them out of the detail as well as the error', () => {
    expect(humanError(t, 'send failed', 'InsufficientFunds { available: Zatoshis(1), required: Zatoshis(2) }'))
      .toBe('have 0.00000001 need 0.00000002')
  })

  it('falls back to the generic message when the figures are not there', () => {
    expect(humanError(t, 'insufficient funds')).toBe('error.insufficient')
  })
})
