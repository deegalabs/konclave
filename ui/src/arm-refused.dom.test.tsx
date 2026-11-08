// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'

// The provider itself, not the predicate: a device that cannot sign does not arm, looked up by the
// vault's id. An earlier version looked it up by the proposal's id and found nothing.
const h = vi.hoisted(() => ({ arm: vi.fn(async () => {}), say: vi.fn(), list: vi.fn(), refusal: vi.fn() }))
vi.mock('./useBackgroundSigner', () => ({
  useBackgroundSigner: () => ({ ready: true, phase: 'idle', error: '', what: null, setProposal: () => {}, unarm: async () => {}, arm: h.arm, sayError: h.say, clearError: () => {}, retry: async () => {} }),
}))
vi.mock('./api', () => ({ getVault: async () => ({ id: 'vault' }), getProposalDetail: async () => null, IS_NET: true }))
vi.mock('./storage', () => ({ listVaults: h.list }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ uaReceiver: () => '' }))
vi.mock('./session', async (orig) => ({ ...(await orig<typeof import('./session')>()), deviceRefusal: h.refusal }))

const { VaultSignerProvider, useVaultSigner } = await import('./VaultSigner')

async function arm() {
  let ctx: ReturnType<typeof useVaultSigner> | null = null
  function Probe() { ctx = useVaultSigner(); return null }
  render(<VaultSignerProvider><Probe /></VaultSignerProvider>)
  await act(async () => { ctx!.open({ id: 'proposal' } as never) })
  await waitFor(() => expect(ctx).not.toBeNull())
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  await act(async () => { await ctx!.armActive() })
}

describe('armActive', () => {
  beforeEach(() => { h.arm.mockClear(); h.say.mockClear(); h.refusal.mockReset(); h.list.mockReset() })
  afterEach(cleanup)
  it('a refused record does not arm', async () => {
    h.list.mockResolvedValue([{ id: 'vault', cp: 3, receiversState: 'refused' }])
    await arm()
    expect(h.arm).not.toHaveBeenCalled()
    expect(h.say).toHaveBeenCalledTimes(1)
  })
  it('a seat the coordinator refused does not arm', async () => {
    h.list.mockResolvedValue([{ id: 'vault', cp: 3, receiversState: 'verified' }])
    h.refusal.mockImplementation((id: string) => (id === 'vault' ? 'seat_bound' : undefined))
    await arm()
    expect(h.arm).not.toHaveBeenCalled()
  })
  it('a verified device does', async () => {
    h.list.mockResolvedValue([{ id: 'vault', cp: 3, receiversState: 'verified' }])
    await arm()
    expect(h.arm).toHaveBeenCalledTimes(1)
  })
})
