import { describe, expect, it, vi } from 'vitest'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { codeOf } from './source-scan'

// What the screen makes of the coordinator's answers, from the wire to the words. Each answer goes through the real client
// (`executeProposal`, `voteProposal` in helper.ts) over a stubbed fetch, then through the rule the
// screen uses (`readReply`, `voteFailure`, `humanError`).
const mem = new Map<string, string>()
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.setItem) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
}
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
let answer: { status: number; body: unknown } = { status: 200, body: {} }
vi.stubGlobal('fetch', async () => new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status }))

const { executeProposal, voteProposal } = await import('./helper')
const { lastHelperPostFailure } = await import('./helper')
const { readReply } = await import('./send-outcome')
const { humanError, proposalFailure, voteFailure } = await import('./api')

const send = () => executeProposal({ vault: 'gp', proposalId: 'p1', relayBase: 'https://relay.invalid', room: 'r', dryRun: false })
const tFor = (d: Record<string, string>) => (k: string, v?: Record<string, string | number>) =>
  (d[k] ?? k).replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? `{${n}}`))

describe('a send that may be on the network is never read as "nothing was sent"', () => {
  it('a 409 that names ready reads as unknown', async () => {
    answer = { status: 409, body: { error: 'may be on the network', state: 'ready' } }
    expect(readReply(await send())).toEqual({ kind: 'held' })
  })

  it('an error with a txid reads as unknown, and the txid reaches the screen', async () => {
    answer = { status: 502, body: { error: 'may be on the network', txid: 'f00d' } }
    expect(readReply(await send())).toEqual({ kind: 'held', txid: 'f00d' })
  })

  it('500 with a reason: nothing was sent', async () => {
    answer = { status: 500, body: { error: 'nothing was sent' } }
    expect(readReply(await send()).kind).toBe('not-sent')
  })

  it('a 2xx whose body is lost or not JSON, or a bare 500, may follow a broadcast: asked of the record', async () => {
    for (const a of [{ status: 200, body: null }, { status: 200, body: 'not json' }, { status: 200, body: {} }, { status: 500, body: null }]) {
      answer = a
      expect(readReply(await send()), JSON.stringify(a)).toEqual({ kind: 'resolve' })
    }
  })

  it('a bare gateway error is asked of the record', async () => {
    answer = { status: 504, body: null }
    expect(readReply(await send())).toEqual({ kind: 'resolve' })
  })
})

describe('a vote the coordinator could not take because it cannot read the vault\'s devices', () => {
  const UNREADABLE = "this vault's device list cannot be read, so nothing can be changed until the operator restores it"

  it('is not "this vote no longer applies", in either language', async () => {
    answer = { status: 503, body: { error: UNREADABLE } }
    expect(await voteProposal('gp', 'p1', 'Ana', true)).toBeNull()
    const code = voteFailure(lastHelperPostFailure())
    for (const d of [en, ptBR]) {
      const text = humanError(tFor(d), code)
      expect(text).not.toBe(d['error.voteRejected'])
      expect(text).toBe(d['error.devicesUnreadable'])
    }
  })

  it('a coordinator that is down is not a vote conflict either', async () => {
    answer = { status: 503, body: null }
    await voteProposal('gp', 'p1', 'Ana', true)
    const code = voteFailure(lastHelperPostFailure())
    for (const d of [en, ptBR]) expect(humanError(tFor(d), code)).toBe(d['error.coordinatorUnavailable'])
  })

  it('a refused vote with no other reason is still a conflict, a 401 still an unproven seat', () => {
    expect(voteFailure({ status: 409 })).toBe('vote rejected')
    expect(voteFailure({ status: 500 })).toBe('coordinator unavailable')
    expect(voteFailure({ status: 401 })).toBe('write not authorized')
    expect(voteFailure({ status: 403, error: 'you can only vote for your own seat' })).toBe('you can only vote for your own seat')
  })
})

// The coordinator's own sentence for this refusal (helper-server/src/main.rs, `vote_of`).
const SEAT_REQUIRED_SENTENCE =
  'More than one member has this name, so the vote must say which seat it is for. Unlock the vault on this device and try again.'

describe('a vote or a proposal the coordinator refused with seat_required (#575)', () => {
  it('tells the member to unlock this device, in both languages, not that the vote conflicts', async () => {
    const f = { status: 400, error: SEAT_REQUIRED_SENTENCE, code: 'seat_required' }
    expect(voteFailure(f)).toBe('seat required')
    for (const d of [en, ptBR]) {
      expect(humanError(tFor(d), voteFailure(f))).toBe(d['error.seatRequired'])
      expect(d['error.seatRequired']).not.toBe(d['error.voteRejected'])
    }
    // Another 400 is still a conflict.
    expect(voteFailure({ status: 400, error: 'x', code: 'other' })).toBe('vote rejected')
  })
})

describe('a payment or a payroll the coordinator refused with seat_required (#575)', () => {
  it('reads as seat required through the wire, in both languages', async () => {
    answer = { status: 400, body: { error: SEAT_REQUIRED_SENTENCE, code: 'seat_required' } }
    await voteProposal('gp', 'p1', 'alice', true)
    const r = proposalFailure(lastHelperPostFailure())
    expect(r).toEqual({ ok: false, error: 'seat required' })
    for (const d of [en, ptBR]) expect(humanError(tFor(d), r.error)).toBe(d['error.seatRequired'])
    expect(proposalFailure({ status: 400, error: 'x', code: 'other' })).toEqual({ ok: false, error: 'x' })
    expect(proposalFailure({ status: 401 })).toEqual({ ok: false, error: 'write not authorized' })
    expect(proposalFailure(null)).toEqual({ ok: false, error: 'proposal rejected', detail: 'the coordinator did not say why' })
  })

  it('the payment and the payroll read a refusal through the one function', async () => {
    const src = codeOf('api.ts')
    const body = (name: string) => src.slice(src.indexOf(`export async function ${name}(`), src.indexOf('\nexport ', src.indexOf(`export async function ${name}(`) + 1))
    for (const name of ['createProposal', 'createPayroll']) {
      expect(body(name)).toContain('return proposalFailure(lastHelperPostFailure())')
      expect(body(name)).not.toContain("error: 'write not authorized'")
    }
  })
})
