import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeAt } from './source-scan'

// What the app does with a coordinator busy answer, tested by behaviour (the audits of e3a2d26:
// temp/busy/). The contract is hub briefs/busy-contract-2026-10-21.md.

const GK = 'a'.repeat(64)
let calls: { at: number; body: string }[] = []
function coordinator(answers: { status: number; body: unknown }[]) {
  calls = []
  let i = 0
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls.push({ at: Date.now(), body: String(init?.body ?? '') })
    const a = answers[Math.min(i++, answers.length - 1)]!
    return new Response(JSON.stringify(a.body), { status: a.status })
  })
}
const busy = (extra: Record<string, unknown> = {}) => ({ status: 503, body: { error: 'busy', busy: 'vault', retry_after: 2, ...extra } })

beforeEach(() => {
  vi.useFakeTimers()
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
  localStorage.setItem('konclave.coord.mode', 'custom')
  localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function settle<T>(p: Promise<T>, ms = 300_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms)
  return p
}
const sendArgs = { vault: GK, proposalId: 'p1', relayBase: '', room: 'r', dryRun: false }

describe('busyOf reads only a 503, and only the three codes', () => {
  it('ignores the field on any other status', async () => {
    const { busyOf } = await import('./helper')
    expect(busyOf(200, { busy: 'vault' })).toBeNull()
    expect(busyOf(409, { busy: 'vault' })).toBeNull()
    expect(busyOf(503, { busy: 'wallet' })).toBe('wallet')
    expect(busyOf(503, { busy: 'later' })).toBeNull()
  })
})

describe('a busy answer that carries a txid or a state is not a clean busy', () => {
  // The contract says it never does. If one does, the txid means the payment may be on the network:
  // that outranks "not started", as it does for every other refusal.
  it('readReply puts the txid and the state first', async () => {
    const { readReply } = await import('./send-outcome')
    expect(readReply({ error: 'x', busy: 'vault', txid: 't1' })).toEqual({ kind: 'held', txid: 't1' })
    expect(readReply({ error: 'x', busy: 'vault', state: 'ready' })).toEqual({ kind: 'held' })
    expect(readReply({ error: 'x', busy: 'vault', state: 'sent' })).toEqual({ kind: 'resolve', sentElsewhere: true })
    expect(readReply({ error: 'x', busy: 'vault' })).toEqual({ kind: 'busy' })
  })

  it('the send is not retried, and the txid reaches the ending', async () => {
    const { executeProposal } = await import('./helper')
    const { readReply } = await import('./send-outcome')
    coordinator([busy({ txid: 't1' })])
    expect(readReply(await settle(executeProposal(sendArgs)))).toEqual({ kind: 'held', txid: 't1' })
    expect(calls).toHaveLength(1)
  })
})

describe('the retry waits are bounded on both sides', () => {
  it('a fractional retry_after still waits at least a second', async () => {
    const { registerReadKey } = await import('./helper')
    coordinator([busy({ retry_after: 0.3 }), busy({ retry_after: 0.3 }), { status: 200, body: { ok: true } }])
    await settle(registerReadKey(GK, 'b'.repeat(64)))
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(1000)
  })

  it('a write gives up within about 20 s, a send within about two minutes, and neither hammers', async () => {
    const { registerReadKey, executeProposal } = await import('./helper')
    coordinator([busy()])
    await settle(registerReadKey(GK, 'b'.repeat(64)))
    expect(calls).toHaveLength(3)
    expect(calls.at(-1)!.at - calls[0]!.at).toBeLessThanOrEqual(20_000)
    coordinator([busy({ retry_after: 0.001 })])
    await settle(executeProposal(sendArgs))
    expect(calls.at(-1)!.at - calls[0]!.at).toBeLessThanOrEqual(120_000)
    expect(calls.length).toBeLessThanOrEqual(20)
  })

  it('the send tells its caller each time it waits on a busy vault', async () => {
    const { executeProposal } = await import('./helper')
    coordinator([busy(), busy(), { status: 200, body: { txid: 't', dry_run: false, state: 'sent' } }])
    const onBusy = vi.fn()
    await settle(executeProposal({ ...sendArgs, onBusy }))
    expect(onBusy).toHaveBeenCalledTimes(2)
  })
})

describe('a busy "wallet" on a write is not a busy write', () => {
  it('is not retried and not reported as busy', async () => {
    const { registerReadKey, lastHelperPostFailure } = await import('./helper')
    coordinator([{ status: 503, body: { error: 'x', busy: 'wallet' } }, { status: 200, body: { ok: true } }])
    expect(await settle(registerReadKey(GK, 'b'.repeat(64)))).toBe(false)
    expect(calls).toHaveLength(1)
    expect(lastHelperPostFailure()?.busy).toBeFalsy()
  })
})

describe('renaming a member goes through the same retry', () => {
  it('lands on the retry, and a busy that never clears is worded by the app', async () => {
    const { renameMember } = await import('./helper')
    coordinator([busy(), { status: 200, body: { members: ['Ana', 'Bia'] } }])
    expect(await settle(renameMember(GK, 'A', 'Ana'))).toEqual({ members: ['Ana', 'Bia'] })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toBe(calls[0]!.body)
    coordinator([busy()])
    expect(await settle(renameMember(GK, 'A', 'Ana'))).toEqual({ error: 'vault busy' })
  })

  it('"vault busy" is said in the member\'s language', async () => {
    const { humanError } = await import('./api')
    expect(humanError((k) => k, 'vault busy')).toBe('registration.tryAgain')
  })
})

describe('what each send ending does to the signatures (one rule for the panel)', () => {
  it('only a failure withdraws them; busy releases the send memory and keeps them', async () => {
    const { stepEffects } = await import('./send-preflight')
    expect(stepEffects({ do: 'fail', text: 'x' })).toEqual({ endAs: 'not-sent', withdraw: true })
    expect(stepEffects({ do: 'busy' })).toEqual({ endAs: 'not-sent', withdraw: false })
    expect(stepEffects({ do: 'unknown', why: 'lost' })).toEqual({ endAs: 'unknown', withdraw: false })
    expect(stepEffects({ do: 'sent', txid: 't' })).toEqual({ endAs: null, withdraw: false })
  })

  it('a busy step is shown as busy', async () => {
    const { stepResult } = await import('./send-preflight')
    expect(stepResult({ do: 'busy' })).toEqual({ busy: true })
  })

  it('the panel withdraws only when the rule says so', () => {
    const code = codeAt(new URL('./screens/SigningPanel.tsx', import.meta.url).pathname)
    const apply = code.slice(code.indexOf('function apply('), code.indexOf('async function doSend('))
    expect(apply).toMatch(/stepEffects\(/)
    expect(apply.match(/unarmActive\(/g)?.length).toBe(1)
    expect(apply).toMatch(/if \(fx\.withdraw\) void unarmActive\(/)
  })
})

describe('who may fire the send (one rule for the effect and the button)', () => {
  it('only the device the room named, while it is armed, and once per attempt', async () => {
    const { fireSend, newSendAttempt, endSend } = await import('./send-attempt')
    const a = newSendAttempt()
    expect(fireSend(a, 'p1', { named: false, armed: true })).toBe(false)
    expect(fireSend(a, 'p1', { named: true, armed: false })).toBe(false)
    expect(fireSend(a, 'p1', { named: true, armed: true })).toBe(true)
    expect(fireSend(a, 'p1', { named: true, armed: true }), 'a double click sent twice').toBe(false)
    endSend(a, 'p1', 'not-sent')
    expect(fireSend(a, 'p1', { named: true, armed: true })).toBe(true)
  })

  it('the room\'s decision and "Try sending again" both ask it', () => {
    const code = codeAt(new URL('./screens/SigningPanel.tsx', import.meta.url).pathname)
    expect(code.match(/fireSend\(attempt\.current, active\.id, \{ named: bg\.iSend, armed \}\)/g)?.length).toBe(2)
    expect(code, 'a second rule for firing the send').not.toMatch(/takeSend\(/)
  })

  it('the busy ending is shown only while the signatures still stand', () => {
    const code = codeAt(new URL('./screens/SigningPanel.tsx', import.meta.url).pathname)
    expect(code).toMatch(/busySend && armed \?/)
  })
})
