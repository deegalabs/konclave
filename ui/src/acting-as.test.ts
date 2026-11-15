import { beforeEach, describe, expect, it, vi } from 'vitest'

// #591 on the wire. A device proposes under the name the COORDINATOR serves for the seat its share
// holds, and signs the proof for that same seat. It never proposes as another seat, and never under
// a name the coordinator did not serve ("member 2", this device's own roster, the first member).
const mem = new Map<string, string>()
if (typeof globalThis.localStorage === 'undefined' || !globalThis.localStorage?.setItem) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  })
}
const VAULT = 'a'.repeat(64)
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
localStorage.setItem('konclave.selectedVault', VAULT)

const signed: { target: string; seat: number; action: string }[] = []
vi.mock('./device-key', async (orig) => ({
  ...(await orig<typeof import('./device-key')>()),
  signGovernanceWrite: (_kp: Uint8Array, _v: string, action: string, target: string, seat: number) => {
    signed.push({ action, target, seat })
    return { proof_seat: seat } as never
  },
}))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))

let served: string[] | null = ['Ana', 'Bia']
const posts: { url: string; body: Record<string, unknown> }[] = []
const made = {
  id: 'p1', vault_id: VAULT, kind: 'payment', to: 'u1x', amount_zat: 1000000, memo: null,
  proposer: 'x', state: 'pending', approvals: [], refusals: [], threshold: 2, total: 2,
  created_at_unix: 1, expiry_unix: 0, txid: null,
}
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  if (init?.body) {
    posts.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify(made), { status: 200 })
  }
  if (String(url).includes('/api/vault/members')) {
    return served === null ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ members: served }), { status: 200 })
  }
  return new Response('{}', { status: 404 })
})

const { actingAs, createProposal, createPayroll, IS_NET } = await import('./api')
const { setUnlockedShare, clearUnlockedShare } = await import('./session')

function unlockSeat(seat: number, myName?: string, roster: string[] = []) {
  const bundle = { kp: 'AA==', pubkeys: 'AA==', seat, n: 2, t: 2 }
  setUnlockedShare(VAULT, {
    groupKey: new Uint8Array(32), address: '', roster, myName, createdAt: 0,
    sealedShare: new TextEncoder().encode(JSON.stringify(bundle)),
  } as never)
}

const pay = { proposer: 'Alice', to_address: 'u1x', value_zec: '0.01' }
const lines = [{ address: 'u1x', value_zec: '0.01' }]

describe('acting as the seat this device holds (#591)', () => {
  beforeEach(() => { signed.length = 0; posts.length = 0; served = ['Ana', 'Bia']; clearUnlockedShare(VAULT) })

  it('runs against the coordinator (the browser path)', () => { expect(IS_NET).toBe(true) })

  it('seat 2 with no myName acts as the served list\'s seat 2', async () => {
    unlockSeat(2)
    expect(await actingAs(VAULT)).toEqual({ ok: true, seat: 2, name: 'Bia' })
  })

  it('a stale myName does not decide: the seat does', async () => {
    unlockSeat(2, 'Ana')
    expect(await actingAs(VAULT)).toEqual({ ok: true, seat: 2, name: 'Bia' })
  })

  it('a locked device is told to unlock, and nothing is guessed', async () => {
    expect(await actingAs(VAULT)).toEqual({ ok: false, why: 'locked' })
  })

  it('a list that could not be read is not replaced by this device\'s own roster', async () => {
    unlockSeat(2, 'Bia', ['Ana', 'Bia'])
    served = null
    expect(await actingAs(VAULT)).toEqual({ ok: false, why: 'list-unread' })
  })

  it('a blank or missing position is no name, never "member 2"', async () => {
    unlockSeat(2, undefined, ['Ana', 'Bia'])
    served = ['Ana', '  ']
    expect(await actingAs(VAULT)).toEqual({ ok: false, why: 'no-seat-name' })
    served = []
    expect(await actingAs(VAULT)).toEqual({ ok: false, why: 'no-seat-name' })
  })

  it('returns the served name trimmed, nothing else normalised', async () => {
    unlockSeat(1)
    served = [' Ana ', 'Bia']
    expect(await actingAs(VAULT)).toEqual({ ok: true, seat: 1, name: 'Ana' })
  })

  it('a payment from seat 2 goes out as the served seat 2 and the proof names the same seat', async () => {
    unlockSeat(2)
    const res = await createProposal(pay) // the screen's own name ("Alice") is not what is sent
    expect(res.ok).toBe(true)
    expect(posts.at(-1)!.body.proposer).toBe('Bia')
    expect(signed.at(-1)).toEqual({ action: 'propose', target: 'Bia', seat: 2 })
  })

  it('a payroll from seat 2 goes out as the served seat 2 and the proof names the same seat', async () => {
    unlockSeat(2)
    const res = await createPayroll('Alice', lines)
    expect(res.ok).toBe(true)
    expect(posts.at(-1)!.body.proposer).toBe('Bia')
    expect(signed.at(-1)).toEqual({ action: 'propose', target: 'Bia', seat: 2 })
  })

  it('locked: no proposal is sent, and the reason is named', async () => {
    const a = await createProposal(pay)
    const b = await createPayroll('Alice', lines)
    expect(posts).toHaveLength(0)
    expect(a).toMatchObject({ ok: false, error: 'proposer unresolved', detail: 'locked' })
    expect(b).toMatchObject({ ok: false, error: 'proposer unresolved', detail: 'locked' })
  })

  it('list unread: refused, never "member 2" and never this device\'s roster', async () => {
    unlockSeat(2, 'Bia', ['Ana', 'Bia'])
    served = null
    const a = await createProposal(pay)
    const b = await createPayroll('Bia', lines)
    expect(posts).toHaveLength(0)
    expect(a).toMatchObject({ ok: false, detail: 'list-unread' })
    expect(b).toMatchObject({ ok: false, detail: 'list-unread' })
  })

  it('an unnamed seat is refused before anything is sent', async () => {
    unlockSeat(2)
    served = ['Ana', '']
    expect(await createProposal(pay)).toMatchObject({ ok: false, detail: 'no-seat-name' })
    expect(posts).toHaveLength(0)
  })
})
