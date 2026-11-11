import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// F-2: two registrations in one document. The failure a registration reads must be the failure of ITS
// own call. A module-wide "last failure" let vault B's 409 stand in for vault A's roster answer, so A
// finished (pending cleared) with no roster on the coordinator.
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const BUNDLE = JSON.stringify({ pkp: 'aa', proofs: [] })

const h = vi.hoisted(() => ({ finished: vi.fn(async (..._a: unknown[]) => {}), adopt: vi.fn() }))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => [{
    id: A, name: 'A', groupKey: A, address: '', roster: ['Ana', 'Bo'], createdAt: 1,
    pending: true, threshold: 2, total: 2, cp: 3, pinBundle: BUNDLE,
  }],
  updateVaultMeta: h.finished,
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
  h.adopt.mockResolvedValue({ state: 'verified', address: 'u1served' })
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('a registration reads the failure of its own call', () => {
  it("another vault's 409 cannot stand in for this vault's missing roster answer", async () => {
    let releaseMembers!: (r: Response) => void
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/vault') && init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ vault_id: A, address: 'u1x', threshold: 2, total: 2, state: 'pinned', pkp_digest: 'd1' }), { status: 200 }))
      }
      if (url.endsWith('/api/vault/members')) return new Promise<Response>((r) => { releaseMembers = r })
      // Vault B's own, unrelated write: refused with a 409.
      return Promise.resolve(new Response(JSON.stringify({ error: 'exists' }), { status: 409 }))
    })
    const { concludeRegistration } = await import('./conclude-registration')
    const { registerReadKey } = await import('./helper')
    const run = concludeRegistration(A)
    await vi.waitFor(() => expect(releaseMembers).toBeTypeOf('function'))
    // B's registration fails while A's roster call is still in flight ...
    expect(await registerReadKey(B, 'ee'.repeat(32))).toBe(false)
    // ... then A's call ends with no usable answer.
    releaseMembers(new Response('{}', { status: 200 }))
    const r = await run
    expect(r).not.toHaveProperty('address')
    expect(r).toEqual({ refused: 'unreachable' })
    expect(h.finished).not.toHaveBeenCalledWith(A, expect.objectContaining({ pending: false }))
  })
})

describe('the registration paths do not go back to the shared slot', () => {
  it('neither file that finishes a registration reads lastHelperPostFailure', async () => {
    const { codeOf } = await import('./source-scan')
    for (const f of ['./conclude-registration.ts', './device-registration.ts']) {
      expect(codeOf(f), f).not.toMatch(/lastHelperPostFailure/)
    }
  })
})
