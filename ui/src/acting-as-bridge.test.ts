import { describe, expect, it, vi } from 'vitest'

// #591: the local bridge signs no writes and keeps what it did, behind an explicit branch inside
// `actingAs`: the body carries the name the screen passed, and no proof, and the coordinator's
// member list is never asked for.
const posts: Record<string, unknown>[] = []
const urls: string[] = []
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  urls.push(String(url))
  if (init?.body) { posts.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 'p1' }), { status: 201 }) }
  return new Response('{}', { status: 404 })
})
const { createProposal, createPayroll, IS_NET } = await import('./api')

describe('the local bridge path is unchanged (#591)', () => {
  it('is the bridge', () => { expect(IS_NET).toBe(false) })
  it('a payment sends the screen\'s name as it did', async () => {
    await createProposal({ proposer: 'Alice', to_address: 'u1x', value_zec: '0.01' })
    expect(posts.at(-1)).toMatchObject({ proposer: 'Alice', to_address: 'u1x' })
    expect(posts.at(-1)).not.toHaveProperty('proof_seat')
  })
  it('a payroll sends the screen\'s name as it did', async () => {
    await createPayroll('Alice', [{ address: 'u1x', value_zec: '0.01' }])
    expect(posts.at(-1)).toMatchObject({ proposer: 'Alice' })
  })
  it('never asks for the coordinator\'s member list', () => {
    expect(urls.some((u) => u.includes('/api/vault/members'))).toBe(false)
  })
})
