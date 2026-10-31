// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// #320: the book's could-not-read state names the reason of the read the book actually made.
// On the web the book is the vault's proposals, so the reason lives under /api/vault/proposals;
// asking /api/vault/ledger, a route the web never reads, always answered "no reason".
// These tests go through the real reader: a fetch that fails, getLedger, then the reason.

describe('the reason shown for a book that could not be read', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); localStorage.clear() })

  it('on the web, is the reason of the proposals read getLedger made', async () => {
    vi.stubEnv('VITE_HELPER_BASE', 'https://coordinator.example')
    vi.resetModules()
    localStorage.setItem('konclave.selectedVault', 'ab'.repeat(32))
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const { getLedger, ledgerReadFailure, IS_NET } = await import('./api')
    expect(IS_NET).toBe(true)
    expect(await getLedger()).toBeNull()
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/vault/proposals')
    expect(ledgerReadFailure()?.reason).toBe('denied')
  })

  it('on the local bridge, is the reason of the /api/ledger read', async () => {
    vi.stubEnv('VITE_HELPER_BASE', '')
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    const { getLedger, ledgerReadFailure, IS_NET } = await import('./api')
    expect(IS_NET).toBe(false)
    expect(await getLedger()).toBeNull()
    expect(ledgerReadFailure()?.reason).toBe('missing')
  })
})
