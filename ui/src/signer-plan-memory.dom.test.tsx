// @vitest-environment jsdom
// The provider itself, mounted, over later readings. approved-plan.test.ts proves
// planAfterRead and scans the source for its call; this runs the effect, the ref and the gate together.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'

const getProposalDetail = vi.hoisted(() => vi.fn())
const captured = vi.hoisted(() => ({ decide: null as null | ((o: unknown[]) => string), unarm: vi.fn(async () => {}) }))

vi.mock('./useBackgroundSigner', () => ({
  useBackgroundSigner: (_u: unknown, _g: unknown, decide: (o: unknown[]) => string) => {
    captured.decide = decide
    return { ready: false, phase: 'idle', error: '', what: null, setProposal: () => {}, unarm: captured.unarm, arm: async () => {}, retry: async () => {}, clearError: () => {} }
  },
}))
vi.mock('./api', () => ({
  // A new object on every read, as the real one: a reseat re-runs the provider's read.
  getVault: async () => ({ id: 'vtest000', threshold: 2, member_list: [] }),
  getProposalDetail,
  IS_NET: true,
}))
vi.mock('./storage', () => ({ listVaults: async () => [{ id: 'vtest000', myName: 'Ana', address: 'u1vault', changeReceiver: 'u1change' }] }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ uaReceiver: (a: string) => `rcv:${a}` }))

const { VaultSignerProvider, useVaultSigner } = await import('./VaultSigner')
const { forgetPlansForTests } = await import('./approved-payment')
type Ctx = ReturnType<typeof useVaultSigner>

const opened = { id: 'p1', kind: 'payment', state: 'ready', to_address: 'u1payee', value_zat: 5000, value_zec: '0.00005', memo: 'rent' }
const honest = { proposal: opened, lines: [] }
const changed = { proposal: { ...opened, to_address: 'u1other' }, lines: [] }
const other = { ...opened, id: 'p2', to_address: 'u1second', value_zat: 7000, value_zec: '0.00007', memo: '' }

const pays = (to: string, value = 5000, memo: string | null = 'rent') => [{ address: null, value, recipient: `rcv:${to}`, memo }]

async function mounted(): Promise<() => Ctx> {
  let ctx: Ctx | null = null
  function Probe() { ctx = useVaultSigner(); return null }
  render(<VaultSignerProvider><Probe /></VaultSignerProvider>)
  await waitFor(() => expect(ctx!.vault).not.toBeNull())
  return () => ctx!
}
/** Open the panel, and wait until the provider has read `calls` answers in all. */
async function openAndRead(c: () => Ctx, p: typeof opened, calls: number) {
  await act(async () => { c().open(p as never) })
  await waitFor(() => expect(getProposalDetail).toHaveBeenCalledTimes(calls))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
/** A reseat loads the vault again, so the provider reads the proposal again. */
async function reseatAndRead(c: () => Ctx, calls: number) {
  await act(async () => { c().reseat() })
  await waitFor(() => expect(getProposalDetail).toHaveBeenCalledTimes(calls))
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe('later readings, through the mounted provider', () => {
  beforeEach(() => { forgetPlansForTests(); getProposalDetail.mockReset(); captured.decide = null })
  afterEach(cleanup)

  it('control: an answer that agrees is shown and matches what it says, and only that', async () => {
    getProposalDetail.mockResolvedValue(honest)
    const c = await mounted()
    await openAndRead(c, opened, 1)
    expect(c().plan?.lines.map((l) => l.address)).toEqual(['u1payee'])
    expect(captured.decide!(pays('u1payee'))).toBe('match')
    expect(captured.decide!(pays('u1other'))).toBe('mismatch')
  })

  it('the first reading differs from what the member opened: nothing shown, and no output matches', async () => {
    getProposalDetail.mockResolvedValue(changed)
    const c = await mounted()
    await openAndRead(c, opened, 1)
    expect(c().plan).toBeNull()
    expect(captured.decide!(pays('u1other'))).not.toBe('match')
    expect(captured.decide!(pays('u1payee'))).not.toBe('match')
  })

  it('a later reading differs after this device signed: it is no longer signed, and takes its word back once', async () => {
    captured.unarm.mockClear()
    getProposalDetail.mockResolvedValueOnce(honest).mockResolvedValue(changed)
    const c = await mounted()
    await openAndRead(c, opened, 1)
    await act(async () => { await c().armActive() })
    expect(c().armed).toBe(true)
    await reseatAndRead(c, 2)
    expect(c().plan).toBeNull()
    expect(c().armed).toBe(false)
    expect(captured.unarm).toHaveBeenCalledTimes(1)
  })

  it('a later reading differs: the plan and the gate both refuse, for either payment', async () => {
    getProposalDetail.mockResolvedValueOnce(honest).mockResolvedValue(changed)
    const c = await mounted()
    await openAndRead(c, opened, 1)
    expect(captured.decide!(pays('u1payee'))).toBe('match')
    await reseatAndRead(c, 2)
    expect(c().plan).toBeNull()
    expect(captured.decide!(pays('u1other'))).not.toBe('match')
    expect(captured.decide!(pays('u1payee'))).not.toBe('match')
  })

  it('a member reopening from the changed answer does not undo it', async () => {
    getProposalDetail.mockResolvedValueOnce(honest).mockResolvedValue(changed)
    const c = await mounted()
    await openAndRead(c, opened, 1)
    await openAndRead(c, changed.proposal, 2)
    expect(c().plan).toBeNull()
    expect(captured.decide!(pays('u1other'))).not.toBe('match')
  })

  it('a refusal stays: an honest answer after it does not bring the gate back', async () => {
    getProposalDetail.mockResolvedValueOnce(honest).mockResolvedValueOnce(changed).mockResolvedValue(honest)
    const c = await mounted()
    await openAndRead(c, opened, 1)
    await reseatAndRead(c, 2)
    await reseatAndRead(c, 3)
    expect(c().plan).toBeNull()
    expect(captured.decide!(pays('u1payee'))).not.toBe('match')
  })

  it('another payment starts clean, and is not shown the previous plan before its own read', async () => {
    let release: (v: unknown) => void = () => {}
    getProposalDetail.mockResolvedValueOnce(honest).mockImplementationOnce(() => new Promise((r) => { release = r }))
    const c = await mounted()
    await openAndRead(c, opened, 1)
    await openAndRead(c, other, 2)
    expect(c().plan).toBeUndefined() // still reading p2: p1's plan must not stand in for it
    expect(captured.decide!(pays('u1payee'))).toBe('unknown')
    await act(async () => { release({ proposal: other, lines: [] }) })
    await waitFor(() => expect(c().plan?.lines[0]?.address).toBe('u1second'))
    expect(captured.decide!(pays('u1second', 7000, ''))).toBe('match')
  })

  it('a slow answer for the previous payment does not reach the gate of the current one', async () => {
    let release: (v: unknown) => void = () => {}
    getProposalDetail.mockImplementationOnce(() => new Promise((r) => { release = r })).mockResolvedValue({ proposal: other, lines: [] })
    const c = await mounted()
    await openAndRead(c, opened, 1)
    await openAndRead(c, other, 2)
    await act(async () => { release(honest) })
    expect(c().plan?.lines[0]?.address).toBe('u1second')
    expect(captured.decide!(pays('u1payee'))).toBe('mismatch')
    expect(captured.decide!(pays('u1second', 7000, ''))).toBe('match')
  })
})
