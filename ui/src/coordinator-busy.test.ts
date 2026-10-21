import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeAt } from './source-scan'

// The coordinator's typed "busy" answer (hub briefs/busy-contract-2026-10-21.md, v1): a request it
// cannot serve now is a 503 with `busy` ("wallet" for reads; "vault" or "service" for writes) and
// `retry_after` in seconds. Nothing was created, changed or recorded, so the app retries the SAME
// request. An unknown or absent `busy` is read exactly as before, so an old coordinator with this app
// changes nothing. The send keeps every signer's consent while it retries; the 409 "held" answer is
// unchanged.

type Answer = { status: number; body: unknown }
const GK = 'a'.repeat(64)

let bodies: string[] = []
function coordinator(answers: Answer[]) {
  bodies = []
  let i = 0
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.body) bodies.push(String(init.body))
    const a = answers[Math.min(i++, answers.length - 1)]!
    return new Response(JSON.stringify(a.body), { status: a.status })
  })
}
const busy = (kind: string, after = 2): Answer => ({ status: 503, body: { error: 'this vault is busy for a moment; try again shortly', busy: kind, retry_after: after } })
const ok = (body: unknown = { ok: true }): Answer => ({ status: 200, body })

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

/** Run `p` while letting the retry waits pass. */
async function settle<T>(p: Promise<T>, ms = 200_000): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms)
  return p
}

describe('a write answered busy is retried with the same request', () => {
  it('lands on the retry, with the identical body', async () => {
    const { registerReadKey } = await import('./helper')
    coordinator([busy('vault'), ok()])
    expect(await settle(registerReadKey(GK, 'b'.repeat(64)))).toBe(true)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
  })

  it('"service" is a busy write too', async () => {
    const { registerReadKey } = await import('./helper')
    coordinator([busy('service'), ok()])
    expect(await settle(registerReadKey(GK, 'b'.repeat(64)))).toBe(true)
    expect(bodies).toHaveLength(2)
  })

  it('gives up after three tries and says it was busy, never "unreachable"', async () => {
    const { registerReadKey, lastHelperPostFailure } = await import('./helper')
    coordinator([busy('vault')])
    expect(await settle(registerReadKey(GK, 'b'.repeat(64)))).toBe(false)
    expect(bodies).toHaveLength(3)
    expect(lastHelperPostFailure()?.busy).toBe(true)
  })

  it('an unknown or absent busy is read as before: one try, no retry (an old coordinator)', async () => {
    const { registerReadKey, lastHelperPostFailure } = await import('./helper')
    for (const body of [{ error: 'x', busy: 'later' }, { error: 'x' }]) {
      coordinator([{ status: 503, body }, ok()])
      expect(await settle(registerReadKey(GK, 'b'.repeat(64)))).toBe(false)
      expect(bodies).toHaveLength(1)
      expect(lastHelperPostFailure()?.busy).toBeFalsy()
    }
  })
})

describe('a read answered "service" keeps what the screen shows, like "wallet"', () => {
  it('listTransactions reads service as WALLET_BUSY', async () => {
    const { listTransactions, WALLET_BUSY } = await import('./helper')
    coordinator([busy('service')])
    expect(await settle(listTransactions(GK))).toBe(WALLET_BUSY)
  })
})

describe('a send answered busy keeps consent and retries the same request', () => {
  const args = { vault: GK, proposalId: 'p1', relayBase: '', room: 'r', dryRun: false }

  it('is sent on the retry, with the identical body', async () => {
    const { executeProposal } = await import('./helper')
    coordinator([busy('vault'), busy('vault'), ok({ txid: 'tx1', dry_run: false, state: 'sent' })])
    const r = await settle(executeProposal(args))
    expect(r).toEqual({ txid: 'tx1', dry_run: false, state: 'sent' })
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies).size).toBe(1)
  })

  it('keeps retrying for about two minutes, then ends busy: not a failure, no withdrawal', async () => {
    const { executeProposal } = await import('./helper')
    const { readReply } = await import('./send-outcome')
    const { panelStep } = await import('./send-preflight')
    coordinator([busy('vault')])
    const r = await settle(executeProposal(args), 300_000)
    expect(bodies.length).toBeGreaterThan(3)
    const end = readReply(r)
    expect(end).toEqual({ kind: 'busy' })
    const t = (k: string) => k
    expect(panelStep(end, t)).toEqual({ do: 'busy' })
  })

  it('the 409 "held" answer is unchanged', async () => {
    const { executeProposal } = await import('./helper')
    const { readReply } = await import('./send-outcome')
    coordinator([{ status: 409, body: { error: 'proposal is not ready to send', state: 'ready' } }])
    expect(readReply(await settle(executeProposal(args)))).toEqual({ kind: 'held' })
    expect(bodies).toHaveLength(1)
  })

  it('a 503 with no busy is still an unknown outcome (an old coordinator)', async () => {
    const { executeProposal } = await import('./helper')
    coordinator([{ status: 503, body: {} }])
    expect(await settle(executeProposal(args))).toEqual({ unknown: true })
    expect(bodies).toHaveLength(1)
  })
})

describe('the endings of a busy that never cleared', () => {
  it('a registration that stayed busy is "try again", never "unreachable"', () => {
    const code = codeAt(new URL('./conclude-registration.ts', import.meta.url).pathname)
    expect(code).toMatch(/if \(failure\?\.busy\) return \{ refused: 'busy' \}/)
    expect(code).toMatch(/case 'busy': return 'registration\.tryAgain'/)
  })

  it('the signing panel shows a busy send without withdrawing the signatures', () => {
    const code = codeAt(new URL('./screens/SigningPanel.tsx', import.meta.url).pathname)
    const apply = code.slice(code.indexOf('function apply('), code.indexOf('function fail('))
    expect(apply).toMatch(/step\.do === 'busy'/)
    expect(apply, 'a busy send withdrew the signatures').not.toMatch(/unarmActive/)
  })

  it('there is one reader of a busy answer', () => {
    const helper = codeAt(new URL('./helper.ts', import.meta.url).pathname)
    expect(helper).toMatch(/export function busyOf\(/)
    expect(helper.match(/\.busy ===/g) ?? [], 'a second reader of the busy field').toHaveLength(0)
  })
})
