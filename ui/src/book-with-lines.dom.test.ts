// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The book the proposal compares with (getBookWithLines): on the web the vault's proposals already
// carry every payroll's lines, so it is ONE read, however many payrolls the vault has made. Through
// the real reader: a fetch that answers, then the book and its lines.

const VAULT = 'ab'.repeat(32)
const U = (c: string) => 'u1' + c.repeat(76)
const helperRow = (i: number) => ({
  id: `r${i}`, vault_id: VAULT, kind: 'payroll', to: '', amount_zat: 10, proposer: 'Ana', state: 'sent',
  approvals: ['Ana'], refusals: [], threshold: 1, total: 1, created_at_unix: 1759000000 + i, expiry_unix: 0,
  lines: [{ label: `P${i}`, to: U(String.fromCharCode(100 + i)), amount_zat: 10 }],
})

describe('the book with its payroll lines', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear() })

  it('on the web is one read of the proposals, lines included, past any cap', async () => {
    vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
    vi.resetModules()
    localStorage.setItem('konclave.selectedVault', VAULT)
    const rows = Array.from({ length: 20 }, (_, i) => helperRow(i))
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ proposals: rows }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { getBookWithLines, BRIDGE_PAYROLLS_READ, IS_NET } = await import('./api')
    expect(IS_NET).toBe(true)
    const book = await getBookWithLines()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(book!.history).toHaveLength(20)
    expect(Object.keys(book!.linesById)).toHaveLength(20)
    expect(20).toBeGreaterThan(BRIDGE_PAYROLLS_READ)
    expect(book!.linesById.r3![0]).toMatchObject({ label: 'P3', address: U('g'), value_zat: 10 })
  })

  it('on the web, a book that does not answer is null, not an empty book', async () => {
    vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
    vi.resetModules()
    localStorage.setItem('konclave.selectedVault', VAULT)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    const { getBookWithLines } = await import('./api')
    expect(await getBookWithLines()).toBeNull()
  })
})
