import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// F-2, destructive, at the fetch level: two vaults conclude at once in one document. Every POST is held
// and released in a scripted interleaving, A then B and B then A. No vault may finish without its
// own roster answer; a real roster 409 for a vault still lets that vault finish.
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const BUNDLE = JSON.stringify({ pkp: 'aa', proofs: [] })

const h = vi.hoisted(() => ({ meta: vi.fn(), adopt: vi.fn() }))
const rec = (id: string, name: string) => ({
  id, name, groupKey: id, address: '', roster: ['Ana', 'Bo'], createdAt: 1,
  pending: true, threshold: 2, total: 2, cp: 3, pinBundle: BUNDLE,
})
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => [rec(A, 'A'), rec(B, 'B')],
  updateVaultMeta: async (...a: unknown[]) => { h.meta(...a) },
}))
vi.mock('./session', async (orig) => ({
  ...(await orig<typeof import('./session')>()),
  getUnlockedShare: () => ({ groupKey: new Uint8Array(32), sealedShare: new Uint8Array(1), accessSecret: new Uint8Array(32), address: '', roster: [], createdAt: 0 }),
  setUnlockedShare: () => {},
}))
vi.mock('./vault-receivers', () => ({ adoptVaultReceivers: h.adopt }))
vi.mock('./pin-digest', () => ({ ownPkpDigest: async () => 'd1' }))
vi.mock('./device-registration', () => ({ registerThisDevice: async () => true }))

type Ans = { status: number; body: unknown }
const OK_REG = (id: string): Ans => ({ status: 200, body: { vault_id: id, address: 'u1x', threshold: 2, total: 2, state: 'pinned', pkp_digest: 'd1' } })
const OK_MEM: Ans = { status: 200, body: { members: ['Ana', 'Bo'] } }
const NO_LIST: Ans = { status: 200, body: {} }
const R409: Ans = { status: 409, body: { error: 'roster exists' } }
const R500: Ans = { status: 500, body: { error: 'boom' } }
const R502_CODED: Ans = { status: 502, body: { error: 'x', code: 'address_mismatch' } }

let held: Map<string, (r: Response) => void>
beforeEach(() => {
  held = new Map()
  const mem = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(),
  })
  localStorage.setItem('konclave.coord.mode', 'custom')
  localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
  h.adopt.mockResolvedValue({ state: 'verified', address: 'u1served' })
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return Promise.resolve(new Response('null', { status: 404 }))
    const body = JSON.parse(String(init.body)) as { group_key?: string; vault?: string }
    const path = new URL(url).pathname
    const key = `${path}:${body.group_key ?? body.vault}`
    return new Promise<Response>((r) => { held.set(key, r) })
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

const tick = () => new Promise((r) => setTimeout(r, 5))
async function release(key: string, a: Ans) {
  await vi.waitFor(() => expect(held.has(key), key).toBe(true))
  held.get(key)!(new Response(JSON.stringify(a.body), { status: a.status }))
  held.delete(key)
  await tick()
}

type Plan = { reg: Ans; mem?: Ans; finishes: boolean }
const finished = (id: string) => h.meta.mock.calls.some(([v, m]) => v === id && (m as { pending?: boolean }).pending === false)

const scenarios: Array<[string, Plan, Plan]> = [
  ['A roster 409, B roster 500', { reg: OK_REG(A), mem: R409, finishes: true }, { reg: OK_REG(B), mem: R500, finishes: false }],
  ['A roster no list, B roster 409', { reg: OK_REG(A), mem: NO_LIST, finishes: false }, { reg: OK_REG(B), mem: R409, finishes: true }],
  ['A roster 500, B roster OK', { reg: OK_REG(A), mem: R500, finishes: false }, { reg: OK_REG(B), mem: OK_MEM, finishes: true }],
  ['A roster OK, B roster 409', { reg: OK_REG(A), mem: OK_MEM, finishes: true }, { reg: OK_REG(B), mem: R409, finishes: true }],
  ['A roster 502 coded, B roster 409', { reg: OK_REG(A), mem: R502_CODED, finishes: false }, { reg: OK_REG(B), mem: R409, finishes: true }],
  ['A register 500, B register OK + roster 409', { reg: R500, finishes: false }, { reg: OK_REG(B), mem: R409, finishes: true }],
  ['A register 409, B roster no list', { reg: R409, finishes: false }, { reg: OK_REG(B), mem: NO_LIST, finishes: false }],
]

describe('two vaults concluding in one document', () => {
  for (const [label, pa, pb] of scenarios) {
    for (const order of ['A then B', 'B then A'] as const) {
      it(`${label} (${order})`, async () => {
        const { concludeRegistration } = await import('./conclude-registration')
        const ra = concludeRegistration(A)
        const rb = concludeRegistration(B)
        const seq: Array<[string, Plan]> = order === 'A then B' ? [[A, pa], [B, pb]] : [[B, pb], [A, pa]]
        for (const [id, p] of seq) await release(`/api/vault:${id}`, p.reg)
        for (const [id, p] of seq) if (p.mem) await release(`/api/vault/members:${id}`, p.mem)
        const [a, b] = await Promise.all([ra, rb])
        expect('address' in a, `A: ${JSON.stringify(a)}`).toBe(pa.finishes)
        expect('address' in b, `B: ${JSON.stringify(b)}`).toBe(pb.finishes)
        expect(finished(A), 'A pending cleared').toBe(pa.finishes)
        expect(finished(B), 'B pending cleared').toBe(pb.finishes)
        if (pa.mem === R502_CODED) expect(a).toEqual({ refused: 'coded', code: 'address_mismatch' })
      })
    }
  }
})

describe('a write of another vault lands while a roster call is in flight', () => {
  it("B's read-key 409 in the slot cannot finish A after A's roster 500", async () => {
    const { concludeRegistration } = await import('./conclude-registration')
    const { registerReadKey } = await import('./helper')
    const ra = concludeRegistration(A)
    await release(`/api/vault:${A}`, OK_REG(A))
    await vi.waitFor(() => expect(held.has(`/api/vault/members:${A}`)).toBe(true))
    const rk = registerReadKey(B, 'ee'.repeat(32))
    await release(`/api/vault/readkey:${B}`, R409)
    expect(await rk).toBe(false)
    await release(`/api/vault/members:${A}`, R500)
    const a = await ra
    expect(a).toEqual({ refused: 'unreachable' })
    expect(finished(A)).toBe(false)
  })
})
