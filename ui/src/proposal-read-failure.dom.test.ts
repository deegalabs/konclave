// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// #320: the proposal screen tells "could not read" from "not there" by the reason the real reader
// left behind, under the route it actually read. These go through getProposalDetail itself.

describe('the reason shown for a proposal that could not be read', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear() })

  it('on the web, is the reason of the vault proposals read', async () => {
    vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
    vi.resetModules()
    localStorage.setItem('konclave.selectedVault', 'ab'.repeat(32))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const { getProposalDetail, proposalReadFailure } = await import('./api')
    expect(await getProposalDetail('p1')).toBeNull()
    expect(proposalReadFailure('p1')?.reason).toBe('denied')
  })

  it('on the web, a list that was read and does not hold it leaves no reason: it is not there', async () => {
    vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
    vi.resetModules()
    localStorage.setItem('konclave.selectedVault', 'ab'.repeat(32))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ proposals: [] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const { getProposalDetail, proposalReadFailure } = await import('./api')
    expect(await getProposalDetail('p1')).toBeNull()
    expect(proposalReadFailure('p1')).toBeNull()
  })

  it('on the local bridge, is the reason of the read by id', async () => {
    vi.stubEnv('VITE_HELPER_BASE', '')
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    const { getProposalDetail, proposalReadFailure } = await import('./api')
    expect(await getProposalDetail('p1')).toBeNull()
    expect(proposalReadFailure('p1')?.reason).toBe('unavailable')
  })
})
