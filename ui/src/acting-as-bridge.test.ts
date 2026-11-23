import { describe, expect, it, vi } from 'vitest'

// #591: the local bridge signs no writes and keeps what it did, behind an explicit branch inside
// `actingAs`: the body carries the name the screen passed, and no proof, and the coordinator's
// member list is never asked for.
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
})
const posts: Record<string, unknown>[] = []
const postUrls: string[] = []
const urls: string[] = []
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  urls.push(String(url))
  if (init?.body) { postUrls.push(String(url)); posts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 'p1' }), { status: 201 }) }
  if (String(url).includes('/api/vault')) return new Response(JSON.stringify({ vault: { id: 'v', member_list: bridgeMembers } }), { status: 200 })
  return new Response('{}', { status: 404 })
})
const { createProposal, createPayroll, actingAs, IS_NET } = await import('./api')
let bridgeMembers: { name: string }[] = [{ name: 'Ana' }, { name: 'Bia' }]

describe('the local bridge path is unchanged (#591)', () => {
  it('is the bridge', () => { expect(IS_NET).toBe(false) })
  it('a payment sends the screen\'s name as it did', async () => {
    await createProposal('v', { proposer: 'Alice', to_address: 'u1x', value_zec: '0.01' })
    expect(posts.at(-1)).toMatchObject({ proposer: 'Alice', to_address: 'u1x' })
    expect(posts.at(-1)).not.toHaveProperty('proof_seat')
  })
  it('a payroll sends the screen\'s name as it did', async () => {
    await createPayroll('v', 'Alice', [{ address: 'u1x', value_zec: '0.01' }])
    expect(posts.at(-1)).toMatchObject({ proposer: 'Alice' })
  })
  // The bridge serves its own vault and may have no selection: the write goes out as it always did.
  // With a selection that is another vault, it is refused like the web path.
  it('with no selection the write goes out; with another vault selected it is refused', async () => {
    const before = posts.length
    expect(await createProposal('v', { proposer: 'Alice', to_address: 'u1x', value_zec: '0.01' })).toMatchObject({ ok: true })
    expect(posts.length).toBe(before + 1)
    localStorage.setItem('konclave.selectedVault', 'other')
    expect(await createProposal('v', { proposer: 'Alice', to_address: 'u1x', value_zec: '0.01' })).toMatchObject({ ok: false, error: 'vault changed' })
    expect(posts.length).toBe(before + 1)
    localStorage.removeItem('konclave.selectedVault')
  })
  // The server picks its first vault when the URL names none, so the URL names the shown one (A1-a).
  it('with no selection the POST names the shown vault in its URL, payment and payroll', async () => {
    postUrls.length = 0
    await createProposal('v', { proposer: 'Alice', to_address: 'u1x', value_zec: '0.01' })
    await createPayroll('v', 'Alice', [{ address: 'u1x', value_zec: '0.01' }])
    expect(postUrls).toHaveLength(2)
    expect(postUrls[0]).toContain('/api/proposals?vault=v')
    expect(postUrls[1]).toContain('/api/payroll?vault=v')
  })
  it('never asks for the coordinator\'s member list', () => {
    expect(urls.some((u) => u.includes('/api/vault/members'))).toBe(false)
  })

  // The bridge has no seat and signs nothing: its proposer is the vault's first member, with no
  // unlock and no coordinator list. Replacing the branch with a refusal must fail here.
  it('actingAs answers for the bridge with the vault\'s first member and no seat', async () => {
    expect(await actingAs('v')).toEqual({ ok: true, seat: 0, name: 'Ana' })
  })
  it('and says there is no name when the bridge lists no member', async () => {
    bridgeMembers = []
    expect(await actingAs('v')).toEqual({ ok: false, why: 'no-seat-name' })
    bridgeMembers = [{ name: 'Ana' }, { name: 'Bia' }]
  })
})
