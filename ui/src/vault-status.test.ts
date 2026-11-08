// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rememberBalance, rememberProposals, vaultStatus, readAt, readIsStale, openBadgeKey } from './vault-status'
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
  it('once private, stays private: a read without the secret in this tab writes no amounts', () => {
    localStorage.setItem('konclave.status.v1', JSON.stringify({ private: true, openCount: 1, proposalsAt: 1 }))
    rememberBalance('v1', { total_zat: 10_000, spendable_zat: 8_000 })
    rememberProposals('v1', [p('a', 'awaiting', 100, 3_000)])
    const s = stored('v1')
    expect(s.totalZat).toBeUndefined()
    expect(s.spendableZat).toBeUndefined()
    expect(s.reservedZat).toBeUndefined()
    expect(s.private).toBe(true)
    expect(s.balanceAt).toBeGreaterThan(0)
  })
  it('an open vault keeps its figures as before', () => {
    rememberBalance('v2', { total_zat: 10_000, spendable_zat: 8_000 })
    expect(stored('v2').spendableZat).toBe(8_000)
  })
})

describe('how the card reads it', () => {
  const base = { freeZat: 1, freeAt: 100, openCount: 0, lastProposal: null, proposalsAt: 500 }
  it('the card carries the time of the amount when the amount is shown, the proposals read otherwise', () => {
    expect(readAt(base, true)).toBe(100)
    expect(readAt(base, false)).toBe(500)
    expect(readAt({ ...base, proposalsAt: null }, false)).toBeNull()
  })
  it('past a day is stale, by that one time: a locked private card, with no amount, greys too', () => {
    const n = 1_000_000
    expect(readIsStale(n - 86_400 - 1, n)).toBe(true)
    expect(readIsStale(n - 86_400 + 60, n)).toBe(false)
    // The private card shows no amount, so its time is the proposals read, and that one ages.
    expect(readIsStale(readAt({ ...base, freeZat: null, freeAt: null, proposalsAt: n - 90_000 }, false)!, n)).toBe(true)
  })
  it('says one, none, or many open proposals', () => {
    expect([openBadgeKey(0), openBadgeKey(1), openBadgeKey(2)]).toEqual(['vaults.badgeNoOpen', 'vaults.badgeOpenOne', 'vaults.badgeOpen'])
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
  it('the vault card reads the status, carries one read time, and says when nothing was read', () => {
    const src = codeOf('screens/Vaults.tsx')
    expect(src).toMatch(/vaultStatus\(/)
    expect(src).toMatch(/readAt\(/)
    expect(src).toMatch(/t\('vaults\.stateNone'\)/)
    expect(src).toMatch(/fmtDateTime\(/)
    for (const k of ['vaults.badgeOpen', 'vaults.badgeOpenOne', 'vaults.badgeNoOpen', 'vaults.badgeLast', 'vaults.badgeFree', 'vaults.badgeUnread',
      'vaults.readAt', 'vaults.readAtStale', 'vaults.tipFree', 'vaults.tipOpen', 'vaults.tipLast', 'vaults.stateNone', 'vaults.enterNamed']) {
      expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy()
    }
    for (const k of ['vaults.stateFree', 'vaults.stateOpen', 'vaults.stateOpenOne', 'vaults.stateNoOpen', 'vaults.stateLast']) {
      expect(en[k], k).toBeUndefined(); expect(ptBR[k], k).toBeUndefined()
    }
    expect(en['vaults.stateNone']).toBe('Nothing read on this device yet. Enter the vault to see how it stands.')
    expect(ptBR['vaults.stateNone']).toBe('Nada lido neste aparelho ainda. Entre no cofre para ver como está.')
  })
  it('the badges say it in the reviewed words, in both languages', () => {
    const want: Record<string, [string, string]> = {
      'vaults.badgeOpen': ['{n} open proposals', '{n} propostas abertas'],
      'vaults.badgeOpenOne': ['1 open proposal', '1 proposta aberta'],
      'vaults.badgeNoOpen': ['no open proposals', 'nenhuma proposta aberta'],
      'vaults.badgeLast': ['last proposal {date}', 'última proposta {date}'],
      'vaults.badgeFree': ['{amount} ZEC free', '{amount} ZEC livres'],
      'vaults.badgeUnread': ['not read here', 'não lido aqui'],
      'vaults.readAt': ['as of {when} on this device', 'lido neste aparelho em {when}'],
      'vaults.readAtStale': ['as of {when} on this device, over a day ago', 'lido neste aparelho em {when}, há mais de um dia'],
      'vaults.tipFree': ["Spendable balance minus what open proposals reserve, as this device last read it. The reserve is a Konclave rule, not the network's.",
        'Saldo disponível menos o que as propostas abertas reservam, na última leitura deste aparelho. A reserva é regra da Konclave, não da rede.'],
      'vaults.tipOpen': ['Proposals waiting for votes or to be signed and sent, as this device last read them.',
        'Propostas esperando votos ou assinatura e envio, na última leitura deste aparelho.'],
      'vaults.tipLast': ['When the newest proposal was made, open or not.', 'Quando foi feita a proposta mais recente, aberta ou não.'],
      'vaults.enterNamed': ['Enter {name}', 'Entrar em {name}'],
    }
    for (const [k, [e, p]] of Object.entries(want)) { expect(en[k], k).toBe(e); expect(ptBR[k], k).toBe(p) }
    // "Open" is the vault's tag (an open vault); a count of open proposals never reads as a bare "0 open".
    for (const k of ['vaults.badgeOpen', 'vaults.badgeOpenOne', 'vaults.badgeNoOpen']) {
      expect(en[k], k).toMatch(/proposal/); expect(ptBR[k], k).toMatch(/proposta/); expect(ptBR[k], k).not.toMatch(/pendente/i)
    }
  })

})
