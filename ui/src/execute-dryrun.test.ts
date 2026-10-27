import { afterEach, describe, expect, it, vi } from 'vitest'
import { codeAt } from './source-scan'
import { executeProposal } from './helper'

// Whether a send broadcasts is a choice every caller makes, never a default. `dryRun` used to be
// optional with `?? true`, so a forgotten flag silently did a dry run; flipping it to `?? false`
// would make a forgotten flag broadcast, which is worse for the money gate. With no default the type
// checker makes each caller say which one it means.

// Never called: it exists so `tsc -b` fails the day `dryRun` becomes optional again, because the
// expect-error directive below would then be unused, which is itself a type error.
export function callWithoutChoosing() {
  // @ts-expect-error dryRun is required: the caller must choose whether the send broadcasts
  return executeProposal({ vault: 'gk', proposalId: 'p1', relayBase: '', room: 'r' })
}

describe('executeProposal sends exactly the dry_run its caller chose', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function sentBody(dryRun: boolean): Promise<Record<string, unknown>> {
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    })
    localStorage.setItem('konclave.coord.mode', 'custom')
    localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
    let body: Record<string, unknown> = {}
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    await executeProposal({ vault: 'gk', proposalId: 'p1', relayBase: '', room: 'r', dryRun })
    return body
  }

  it('false broadcasts, true does not, and nothing else decides', async () => {
    expect((await sentBody(false)).dry_run).toBe(false)
    expect((await sentBody(true)).dry_run).toBe(true)
  })

  it('has no default for dryRun', () => {
    const src = codeAt(new URL('./helper.ts', import.meta.url).pathname)
    const fn = src.slice(src.indexOf('export async function executeProposal('))
    const head = fn.slice(0, fn.indexOf('): Promise<SendReply>'))
    expect(head, 'dryRun is optional again').not.toMatch(/dryRun\?:/)
    expect(head).toMatch(/\n\s+dryRun: boolean\n/)
    expect(fn, 'a default for dry_run came back').not.toMatch(/dryRun \?\?/)
    expect(fn).toMatch(/dry_run: args\.dryRun,/)
  })
})
