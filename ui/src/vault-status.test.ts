// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rememberBalance, rememberProposals, vaultStatus, statusIsStale, openCountKey } from './vault-status'
import { setReadSecret, clearReadSecret } from './session'
import type { Proposal } from './api'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

/* The list of vaults shows each vault's situation: what is available, what is pending, when it
 * last moved. Not by reading every vault's balance on every visit (a balance read makes the
 * coordinator sync a wallet), but from what this device last saw when it opened the vault, each
 * figure with the time it was seen, or an honest "nothing read on this device yet". */

const p = (id: string, state: string, created_at: number, value_zat = 1000, over: Partial<Proposal> = {}): Proposal => ({
  id, vault_id: 'v', kind: 'payment', state, proposer: 'ana', value_zat, value_zec: '0', is_public: false,
  approvals: [], refusals: [], approvals_count: 0, created_at, ...over,
})
const stored = (v: string) => JSON.parse(localStorage.getItem(`konclave.status.${v}`) ?? 'null')
const nowSec = () => Math.floor(Date.now() / 1000)

beforeEach(() => localStorage.clear())
afterEach(() => { clearReadSecret('v1'); clearReadSecret('v2') })

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
    expect(s.proposalsAt).toBeNull()
  })
  it('after the proposals too: free is spendable minus what open proposals hold, in zatoshi', () => {
    rememberBalance('v1', { total_zat: 10_000, spendable_zat: 8_000 })
    rememberProposals('v1', [p('a', 'awaiting', 100, 3_000), p('b', 'confirmed', 200, 9_000), p('c', 'ready', 150, 1_000)])
    const s = vaultStatus('v1')!
    expect(s.freeZat).toBe(4_000)
    expect(s.openCount).toBe(2)
    expect(s.lastProposal).toBe(200)
  })
  it('counts as open only what can still move: past its deadline on this clock it is not', () => {
    rememberProposals('v1', [p('a', 'awaiting', 100, 3_000, { expiry_unix: 1_000 }), p('b', 'ready', 100, 1_000)])
    expect(vaultStatus('v1')!.openCount).toBe(1)
  })
  it('the free figure carries the older of its two reads, and the count its own', () => {
    localStorage.setItem('konclave.status.v1', JSON.stringify({ totalZat: 10, spendableZat: 10, balanceAt: 1_000, reservedZat: 0, openCount: 0, proposalsAt: 5_000 }))
    const s = vaultStatus('v1')!
    expect(s.freeAt).toBe(1_000)
    expect(s.proposalsAt).toBe(5_000)
  })
  it('keeps its times in seconds, as the dates it is shown with expect', () => {
    rememberProposals('v1', [])
    const at = vaultStatus('v1')!.proposalsAt!
    expect(Math.abs(at - nowSec())).toBeLessThan(5)
  })
  it('keeps each vault apart and ignores a failed read', () => {
    rememberBalance('v1', { total_zat: 1 })
    rememberBalance('v2', null)
    rememberProposals('v2', null)
    expect(vaultStatus('v1')).not.toBeNull()
    expect(vaultStatus('v2')).toBeNull()
  })
  it('survives a corrupt or tampered record: no NaN reaches the screen', () => {
    localStorage.setItem('konclave.status.v1', '{not json')
    expect(vaultStatus('v1')).toBeNull()
    localStorage.setItem('konclave.status.v1', JSON.stringify({ totalZat: 'x', spendableZat: 5, balanceAt: 10, reservedZat: null, openCount: 'two', proposalsAt: 'soon' }))
    const s = vaultStatus('v1')!
    expect(s.freeZat).toBeNull()
    expect(s.openCount).toBeNull()
    expect(s.proposalsAt).toBeNull()
    rememberBalance('v1', { total_zat: 5 })
    expect(vaultStatus('v1')).not.toBeNull()
  })
})

describe('a private vault keeps no amounts on the device', () => {
  it('stores only counts and times for a vault whose secret this tab holds, and shows the amount while it does', () => {
    setReadSecret('v1', new Uint8Array(32).fill(7))
    rememberBalance('v1', { total_zat: 10_000, spendable_zat: 8_000 })
    rememberProposals('v1', [p('a', 'awaiting', 100, 3_000)])
    const s = stored('v1')
    expect(s.totalZat).toBeUndefined()
    expect(s.spendableZat).toBeUndefined()
    expect(s.reservedZat).toBeUndefined()
    expect(s.openCount).toBe(1)
    expect(s.private).toBe(true)
    expect(vaultStatus('v1')!.freeZat).toBe(5_000) // from memory, while unlocked here
    clearReadSecret('v1')
    const locked = vaultStatus('v1')!
    expect(locked.freeZat).toBeNull()
    expect(locked.openCount).toBe(1)
  })
  it('ignores amounts a private record carries anyway', () => {
    localStorage.setItem('konclave.status.v1', JSON.stringify({ private: true, totalZat: 10, spendableZat: 10, balanceAt: 1, reservedZat: 0, openCount: 0, proposalsAt: 1 }))
    expect(vaultStatus('v1')!.freeZat).toBeNull()
  })
  it('an open vault keeps its figures as before', () => {
    rememberBalance('v2', { total_zat: 10_000, spendable_zat: 8_000 })
    expect(stored('v2').spendableZat).toBe(8_000)
  })
})

describe('how the card reads it', () => {
  it('greys the free figure by the age of the free figure, past a day', () => {
    const base = { freeZat: 1, openCount: 0, lastProposal: null, proposalsAt: 0 }
    const n = 1_000_000
    expect(statusIsStale({ ...base, freeAt: n - 86_400 - 1, proposalsAt: n }, n)).toBe(true)
    expect(statusIsStale({ ...base, freeAt: n - 86_400 + 60, proposalsAt: n - 900_000 }, n)).toBe(false)
  })
  it('says one, none, or many open proposals', () => {
    expect([openCountKey(0), openCountKey(1), openCountKey(2)]).toEqual(['vaults.stateNoOpen', 'vaults.stateOpenOne', 'vaults.stateOpen'])
  })
})

describe('the reads leave the figures, and the list shows them', () => {
  // The two paths of each read, apart: a scan of the whole file would be satisfied by one of them.
  const branches = (fn: string) => {
    const api = codeOf('api.ts')
    const start = api.indexOf(`export async function ${fn}(`)
    const body = api.slice(start, api.indexOf('\nexport ', start + 1))
    const net = body.slice(body.indexOf('if (NET) {'), body.indexOf('\n  }\n', body.indexOf('if (NET) {')))
    return { net, rest: body.slice(body.indexOf('\n  }\n', body.indexOf('if (NET) {'))) }
  }
  it('the balance read remembers on the web path and on the local bridge, naming the vault before the request', () => {
    const { net, rest } = branches('readBalance')
    expect(net).toMatch(/rememberBalance\(id,/)
    expect(rest).toMatch(/rememberBalance\(sel,/)
    expect(rest.indexOf('const sel')).toBeLessThan(rest.indexOf('await getJson'))
  })
  it('the proposals read remembers on both paths, naming the vault before the request', () => {
    const { net, rest } = branches('getProposals')
    expect(net).toMatch(/rememberProposals\(id,/)
    expect(rest).toMatch(/rememberProposals\(sel,/)
    expect(rest.indexOf('const sel')).toBeLessThan(rest.indexOf('await getJson'))
  })
  it('the vault card reads the status, dates each figure, and says when nothing was read', () => {
    const src = codeOf('screens/Vaults.tsx')
    expect(src).toMatch(/vaultStatus\(/)
    expect(src).toMatch(/t\('vaults\.stateNone'\)/)
    expect(src).toMatch(/fmtDateTime\(/)
    expect(src).toMatch(/stopPropagation\(\)\}><Secret/) // the veil's click stays in the veil
    for (const k of ['vaults.stateFree', 'vaults.stateOpen', 'vaults.stateOpenOne', 'vaults.stateNoOpen', 'vaults.stateLast', 'vaults.stateNone']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
    }
    for (const k of ['vaults.stateOpen', 'vaults.stateOpenOne', 'vaults.stateNoOpen']) { expect(en[k], k).toContain('{when}'); expect(ptBR[k], k).toContain('{when}') }
    expect(en['vaults.stateNone']).toBe('Nothing read on this device yet. Open it to see how it stands.')
    expect(ptBR['vaults.stateNone']).toBe('Nada lido neste aparelho ainda. Abra para ver como está.')
  })
})
