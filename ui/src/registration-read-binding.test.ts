import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'

// A registration reads the reason of ITS OWN read of the vault. The per-route memory in
// read-failure.ts is shared by every vault in the document, so vault B's 404 landing between A's
// read and A's decision must not turn A's network failure into "no such vault" (nobundle).
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const BUNDLE = JSON.stringify({ pkp: 'aa', proofs: [] })
const h = vi.hoisted(() => ({ meta: vi.fn(async (..._a: unknown[]) => {}), adopt: vi.fn() }))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => [
    { id: A, name: 'A', groupKey: A, address: '', roster: ['Ana', 'Bo'], createdAt: 1, pending: true, threshold: 2, total: 2, cp: 3 },
    { id: B, name: 'B', groupKey: B, address: '', roster: ['Ana', 'Bo'], createdAt: 1, pending: true, threshold: 2, total: 2, cp: 3, pinBundle: BUNDLE },
  ],
  updateVaultMeta: h.meta,
}))
vi.mock('./session', async (orig) => ({
  ...(await orig<typeof import('./session')>()),
  getUnlockedShare: () => ({ groupKey: new Uint8Array(32), sealedShare: new Uint8Array(1), accessSecret: new Uint8Array(32), address: '', roster: [], createdAt: 0 }),
  setUnlockedShare: () => {},
}))
vi.mock('./vault-receivers', () => ({ adoptVaultReceivers: h.adopt }))
vi.mock('./pin-digest', () => ({ ownPkpDigest: async () => 'd1' }))
vi.mock('./device-registration', () => ({ registerThisDevice: async () => true }))

beforeEach(() => {
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(),
  })
  localStorage.setItem('konclave.coord.mode', 'custom')
  localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('the reason of a vault read belongs to the read that failed', () => {
  it("another vault's 404 between A's read and A's decision does not make A say nobundle", async () => {
    const waiting = new Map<string, (r: Response) => void>()
    vi.stubGlobal('fetch', (url: string) => new Promise<Response>((r) => { waiting.set(new URL(url).searchParams.get('vault')!, r) }))
    const { concludeRegistration } = await import('./conclude-registration')
    const { getVault } = await import('./helper')
    const run = concludeRegistration(A)
    await vi.waitFor(() => expect(waiting.has(A)).toBe(true))
    const other = getVault(B)
    await vi.waitFor(() => expect(waiting.has(B)).toBe(true))
    // A's read fails (the coordinator is down), and B's read is a 404, one step behind.
    waiting.get(A)!(new Response('x', { status: 500 }))
    waiting.get(B)!(new Response('x', { status: 404 }))
    expect(await other).toBeNull()
    expect(await run).toEqual({ refused: 'unreachable' })
    expect(h.meta).not.toHaveBeenCalled()
  })

  it('conclude-registration does not read the per-route memory of reads', () => {
    expect(codeOf('./conclude-registration.ts')).not.toMatch(/lastReadFailure/)
  })
})
