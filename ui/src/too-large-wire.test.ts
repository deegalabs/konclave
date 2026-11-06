import { describe, expect, it, vi } from 'vitest'
import { en } from './i18n/en'

// #821, from the wire to the words. The coordinator's `422 too many actions` goes through the real
// clients over a stubbed fetch: `createProposal` and `createPayroll` (api.ts, the two create calls the
// screens use) and `executeProposal` (helper.ts, the send both the signing panel and /net use). If
// any of them dropped the counts, the screen would fall back to a message without them.
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
localStorage.setItem('konclave.selectedVault', 'a'.repeat(64))

// The coordinator's answer, as `too_many_actions_resp` writes it.
const refusal = (plan: 'payment' | 'payroll') => ({
  error: 'too many actions',
  actions: 7,
  max_actions: 6,
  plan,
  detail: `this ${plan} needs 7 parts and one payment can carry at most 6`,
})
let answer: { status: number; body: unknown } = { status: 422, body: refusal('payment') }
vi.stubGlobal('fetch', async () => new Response(JSON.stringify(answer.body), { status: answer.status }))

const { createProposal, createPayroll, humanError, IS_NET } = await import('./api')
const { executeProposal } = await import('./helper')
const { readReply } = await import('./send-outcome')
const { netReplyText, panelStep } = await import('./send-preflight')

const t = (k: string, v?: Record<string, string | number>) =>
  (en as Record<string, string>)[k]!.replace(/\{(\w+)\}/g, (_, n: string) => String(v?.[n] ?? `{${n}}`))
const counted = (key: string) => (en as Record<string, string>)[key]!.replace('{actions}', '7').replace('{max}', '6')

describe('the counts reach the screen on every path', () => {
  it('runs against the coordinator (the browser path)', () => {
    expect(IS_NET).toBe(true)
  })

  it('a payment refused at creation', async () => {
    answer = { status: 422, body: refusal('payment') }
    const res = await createProposal({ proposer: 'alice', to_address: 'u1x', value_zec: '0.01' })
    expect(res).toEqual({ ok: false, error: 'too many actions', tooLarge: { actions: 7, max: 6, plan: 'payment' } })
    if (res.ok) throw new Error('unreachable')
    expect(humanError(t, res.error, res.detail, res.tooLarge)).toBe(counted('error.tooLargePayment'))
  })

  it('a payroll refused at creation', async () => {
    answer = { status: 422, body: refusal('payroll') }
    const res = await createPayroll('alice', [{ address: 'u1x', value_zec: '0.01' }])
    expect(res).toEqual({ ok: false, error: 'too many actions', tooLarge: { actions: 7, max: 6, plan: 'payroll' } })
    if (res.ok) throw new Error('unreachable')
    expect(humanError(t, res.error, res.detail, res.tooLarge)).toBe(counted('error.tooLargePayroll'))
  })

  it('a send refused at its last gate, in the signing panel and on /net', async () => {
    answer = { status: 422, body: refusal('payroll') }
    const r = await executeProposal({ vault: 'gp', proposalId: 'p1', relayBase: 'https://relay.invalid', room: 'r', dryRun: false })
    expect(r).toEqual({ error: 'too many actions', tooLarge: { actions: 7, max: 6, plan: 'payroll' } })
    expect(panelStep(readReply(r), t)).toEqual({ do: 'fail', text: counted('error.tooLargePayroll'), raw: 'too many actions' })
    expect(netReplyText(readReply(r)).en).toBe(counted('error.tooLargePayroll'))
  })

  it('an answer without its counts is not dressed up as one', async () => {
    answer = { status: 422, body: { error: 'too many actions' } }
    const res = await createProposal({ proposer: 'alice', to_address: 'u1x', value_zec: '0.01' })
    expect(res).toEqual({ ok: false, error: 'too many actions' })
    if (res.ok) throw new Error('unreachable')
    expect(humanError(t, res.error, res.detail, res.tooLarge)).toBe(en['error.tooLarge'])
  })
})
