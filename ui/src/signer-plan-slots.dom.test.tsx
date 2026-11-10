// @vitest-environment jsdom
// A reading is remembered per proposal, across looking at another one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
const getProposalDetail = vi.hoisted(() => vi.fn())
const captured = vi.hoisted(() => ({ decide: null as null | ((o: unknown[]) => string) }))
vi.mock('./useBackgroundSigner', () => ({
  useBackgroundSigner: (_u: unknown, _g: unknown, decide: (o: unknown[]) => string) => {
    captured.decide = decide
    return { ready: false, phase: 'idle', error: '', what: null, setProposal: () => {}, unarm: async () => {}, arm: async () => {}, retry: async () => {}, clearError: () => {} }
  },
}))
vi.mock('./api', () => ({ getVault: async () => ({ id: 'vtest000', threshold: 2, member_list: [] }), getProposalDetail, IS_NET: true }))
vi.mock('./storage', () => ({ listVaults: async () => [{ id: 'vtest000', myName: 'Ana', address: 'u1vault', changeReceiver: 'u1change' }] }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ uaReceiver: (a: string) => `rcv:${a}` }))
const { VaultSignerProvider, useVaultSigner } = await import('./VaultSigner')
const { forgetPlansForTests } = await import('./approved-payment')
type Ctx = ReturnType<typeof useVaultSigner>
const p1 = { id: 'p1', kind: 'payment', state: 'ready', to_address: 'u1payee', value_zat: 5000, value_zec: '0.00005', memo: 'rent' }
const p1other = { ...p1, to_address: 'u1other' }
const p2 = { ...p1, id: 'p2', to_address: 'u1second' }
const pays = (to: string) => [{ address: null, value: 5000, recipient: `rcv:${to}`, memo: 'rent' }]
async function mounted() {
  let ctx: Ctx | null = null
  function Probe() { ctx = useVaultSigner(); return null }
  render(<VaultSignerProvider><Probe /></VaultSignerProvider>)
  await waitFor(() => expect(ctx!.vault).not.toBeNull())
  return () => ctx!
}
let calls = 0
async function openRead(c: () => Ctx, p: typeof p1) {
  calls++
  await act(async () => { c().open({ ...p } as never) })
  await waitFor(() => expect(getProposalDetail).toHaveBeenCalledTimes(calls))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
describe('the memory of a read is one slot', () => {
  beforeEach(() => { forgetPlansForTests(); getProposalDetail.mockReset(); calls = 0 })
  afterEach(cleanup)
  it('a refusal stays after the member opened another payment and came back', async () => {
    getProposalDetail.mockResolvedValueOnce({ proposal: p1, lines: [] })
      .mockResolvedValueOnce({ proposal: p1other, lines: [] })
      .mockResolvedValueOnce({ proposal: p2, lines: [] })
      .mockResolvedValueOnce({ proposal: p1, lines: [] })
    const c = await mounted()
    await openRead(c, p1)
    await openRead(c, p1)
    expect(c().plan).toBeNull()
    await openRead(c, p2)
    await openRead(c, p1)
    expect(c().plan).toBeNull()
    expect(captured.decide!(pays('u1payee'))).not.toBe('match')
  })
  it('a difference is still seen after the member opened another payment and came back', async () => {
    getProposalDetail.mockResolvedValueOnce({ proposal: p1, lines: [] })
      .mockResolvedValueOnce({ proposal: p2, lines: [] })
      .mockResolvedValueOnce({ proposal: p1other, lines: [] })
    const c = await mounted()
    await openRead(c, p1)
    await openRead(c, p2)
    await openRead(c, p1other)
    expect(c().plan).toBeNull()
    expect(captured.decide!(pays('u1other'))).not.toBe('match')
  })
})
