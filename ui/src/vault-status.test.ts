// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { rememberBalance, rememberProposals, vaultStatus, forgetStatus } from './vault-status'
import type { Proposal } from './api'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* The list of vaults shows each vault's situation: what is available, what is pending, when it
 * last moved. Not by reading every vault's balance on every visit (a balance read makes the
 * coordinator sync a wallet), but from what this device last saw when it opened the vault, with
 * the time it saw it, or an honest "not opened on this device yet". */

const p = (id: string, state: string, created_at: number, value_zat = 1000): Proposal => ({
  id, vault_id: 'v', kind: 'payment', state, proposer: 'ana', value_zat, value_zec: '0', is_public: false,
  approvals: [], refusals: [], approvals_count: 0, created_at,
})

beforeEach(() => localStorage.clear())

describe('what this device remembers of a vault', () => {
  it('is nothing until the vault was opened here', () => {
    expect(vaultStatus('v1')).toBeNull()
  })
  it('after a balance alone: the balance time, no free figure yet, no pending count', () => {
    rememberBalance('v1', { total_zat: 10_000, spendable_zat: 8_000 })
    const s = vaultStatus('v1')!
    expect(s.freeZat).toBeNull()
    expect(s.freeAt).toBeNull()
    expect(s.openCount).toBeNull()
    expect(s.at).toBeGreaterThan(0)
  })
  it('after the proposals too: free is spendable minus what open proposals hold, in zatoshi', () => {
    rememberBalance('v1', { total_zat: 10_000, spendable_zat: 8_000 })
    rememberProposals('v1', [p('a', 'awaiting', 100, 3_000), p('b', 'confirmed', 200, 9_000), p('c', 'ready', 150, 1_000)])
    const s = vaultStatus('v1')!
    expect(s.freeZat).toBe(4_000)
    expect(s.freeAt).toBe(Math.min(s.at, s.freeAt!)) // the older of the two reads it is made of
    expect(s.openCount).toBe(2)
    expect(s.lastProposal).toBe(200)
  })
  it('the free figure carries the older of its two reads', () => {
    rememberBalance('v1', { total_zat: 10, spendable_zat: 10 })
    const bAt = vaultStatus('v1')!.at
    localStorage.setItem('konclave.status.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('konclave.status.v1')!), balanceAt: bAt - 3600 }))
    rememberProposals('v1', [])
    const s = vaultStatus('v1')!
    expect(s.freeAt).toBe(bAt - 3600)
    expect(s.at).toBeGreaterThanOrEqual(bAt)
  })
  it('keeps each vault apart, ignores a failed read, and forgets on request', () => {
    rememberBalance('v1', { total_zat: 1 })
    rememberBalance('v2', null)
    rememberProposals('v2', null)
    expect(vaultStatus('v1')).not.toBeNull()
    expect(vaultStatus('v2')).toBeNull()
    forgetStatus('v1')
    expect(vaultStatus('v1')).toBeNull()
  })
  it('survives a corrupt record', () => {
    localStorage.setItem('konclave.status.v1', '{not json')
    expect(vaultStatus('v1')).toBeNull()
    rememberBalance('v1', { total_zat: 5 })
    expect(vaultStatus('v1')).not.toBeNull()
  })
})

describe('the reads leave the figures, and the list shows them', () => {
  it('every balance and proposals read on the web path remembers', () => {
    const api = codeOf('api.ts')
    expect(api).toMatch(/rememberBalance\(/)
    expect(api).toMatch(/rememberProposals\(/)
  })
  it('the vault card reads the status and says when nothing was seen', () => {
    const src = codeOf('screens/Vaults.tsx')
    expect(src).toMatch(/vaultStatus\(/)
    expect(src).toMatch(/t\('vaults\.stateNone'\)/)
    expect(src).toMatch(/forgetStatus\(row\.v\.id\)/) // a removed vault takes its figures with it
    expect(src).toMatch(/stopPropagation\(\)\}><Secret/) // the veil's click stays in the veil
    for (const k of ['vaults.stateFree', 'vaults.stateOpen', 'vaults.stateOpenOne', 'vaults.stateNoOpen', 'vaults.stateLast', 'vaults.stateSeen', 'vaults.stateNone']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
    }
  })
})
