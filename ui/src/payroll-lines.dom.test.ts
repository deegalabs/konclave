// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'

// The Ledger's payroll lines (#949). On the web the vault's proposals already carry every payroll's
// lines, so reading the lines of any number of payrolls is ONE read of the proposals. The local bridge
// serves lines by id, so there each payroll is read on its own, with no cap: the Ledger must not lose
// an older payroll's lines. Through the real reader: a fetch that answers, counted.

const VAULT = 'ab'.repeat(32)
const U = (c: string) => 'u1' + c.repeat(76)
const helperRow = (i: number) => ({
  id: `r${i}`, vault_id: VAULT, kind: 'payroll', to: '', amount_zat: 10, proposer: 'Ana', state: 'sent',
  approvals: ['Ana'], refusals: [], threshold: 1, total: 1, created_at_unix: 1759000000 + i, expiry_unix: 0,
  lines: [{ label: `P${i}`, to: U(String.fromCharCode(100 + i)), amount_zat: 10 }],
})

describe("the Ledger's payroll lines", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear() })

  it('on the web, the lines of every payroll asked for come from ONE read of the proposals', async () => {
    vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
    vi.resetModules()
    localStorage.setItem('konclave.selectedVault', VAULT)
    const rows = Array.from({ length: 20 }, (_, i) => helperRow(i))
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ proposals: rows }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { readPayrollLines } = await import('./payroll-lines')
    const ids = rows.map((r) => r.id)
    const lines = await readPayrollLines(ids)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Object.keys(lines)).toHaveLength(20)
    expect(lines.r3![0]).toMatchObject({ label: 'P3', address: U('g'), value_zat: 10 })
    // Only what was asked for; an id the book does not know is absent, as a failed detail read was.
    expect(Object.keys(await readPayrollLines(['r1', 'r2', 'nope']))).toEqual(['r1', 'r2'])
  })

  it('on the local bridge, each payroll is read by id, with no cap', async () => {
    vi.resetModules()
    const asked: string[] = []
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const id = decodeURIComponent(String(url).split('/api/proposals/')[1] ?? '')
      asked.push(id)
      return new Response(JSON.stringify({ proposal: { id, kind: 'payroll' }, lines: [{ label: id, address: U('z'), value_zat: 1 }] }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { readPayrollLines } = await import('./payroll-lines')
    const { BRIDGE_PAYROLLS_READ, IS_NET } = await import('./api')
    expect(IS_NET).toBe(false)
    const ids = Array.from({ length: BRIDGE_PAYROLLS_READ + 3 }, (_, i) => `b${i}`)
    const lines = await readPayrollLines(ids)
    expect(asked).toEqual(ids)
    expect(Object.keys(lines)).toHaveLength(ids.length)
  })
})

describe("the Ledger's payroll lines, what an answer means", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear() })
  it('on the web, a payroll with no lines answers [] and an unreadable book answers nothing', async () => {
    vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
    vi.resetModules()
    localStorage.setItem('konclave.selectedVault', VAULT)
    const empty = { ...helperRow(1), lines: [] }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ proposals: [empty] }), { status: 200 })))
    const { readPayrollLines } = await import('./payroll-lines')
    expect(await readPayrollLines(['r1'])).toEqual({ r1: [] })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    expect(await readPayrollLines(['r1'])).toEqual({})
  })
})

// The pin: the Ledger reads payroll lines through the one function, never one detail read per payroll.
describe('the pin: the Ledger reads lines through readPayrollLines', () => {
  it('Ledger.tsx never calls getProposalDetail, and reads lines through readPayrollLines', () => {
    const src = codeOf('./screens/Ledger.tsx')
    expect(src).not.toMatch(/\bgetProposalDetail\(/)
    expect(src).toMatch(/\breadPayrollLines\(/)
  })
})
