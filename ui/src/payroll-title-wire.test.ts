import { describe, expect, it, vi } from 'vitest'
import type { Proposal as NetProposal } from './helper'

// #296 on the wire: the payroll screen's name goes to the coordinator as `title` (never as a memo),
// and comes back on the read. Over the real clients and a stubbed fetch, as too-large-wire does.
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

const made: NetProposal = {
  id: 'p1', vault_id: 'a'.repeat(64), kind: 'payroll', to: '', amount_zat: 1_000_000, memo: null,
  title: 'Payroll · April 2026', lines: [{ label: 'Ana', to: 'u1x', amount_zat: 1_000_000, memo: null }],
  proposer: 'alice', state: 'pending', approvals: ['alice'], refusals: [], threshold: 2, total: 3,
  created_at_unix: 1, expiry_unix: 0, txid: null,
}
const sent: unknown[] = []
vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
  if (init?.body) sent.push(JSON.parse(String(init.body)))
  return new Response(JSON.stringify(made), { status: 200 })
})

const { createPayroll, mapNetProposal, IS_NET } = await import('./api')

describe('a payroll carries its own name on the web path (#296)', () => {
  it('runs against the coordinator (the browser path)', () => {
    expect(IS_NET).toBe(true)
  })

  it("sends the screen's name as `title`, and not as any line's memo", async () => {
    sent.length = 0
    const res = await createPayroll('alice', [{ address: 'u1x', value_zec: '0.01' }], 'Payroll · April 2026')
    expect(res.ok).toBe(true)
    const body = sent.at(-1) as { title?: string; memo?: string; lines: { memo?: string }[] }
    expect(body.title).toBe('Payroll · April 2026')
    expect(body.memo).toBeUndefined()
    expect(body.lines[0]?.memo).toBeUndefined()
  })

  it('sends no title key when the screen has none', async () => {
    sent.length = 0
    await createPayroll('alice', [{ address: 'u1x', value_zec: '0.01' }])
    expect(sent.at(-1)).not.toHaveProperty('title')
  })

  it('reads the title back, and an old record without one maps to no title', () => {
    expect(mapNetProposal(made).title).toBe('Payroll · April 2026')
    const old = { ...made } as Partial<NetProposal>
    delete old.title
    expect(mapNetProposal(old as NetProposal).title).toBeUndefined()
  })
})
