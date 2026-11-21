// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The writes of api.ts and recent-payees.ts act on the vault they are GIVEN (the one a screen showed)
// and do nothing, saying why, when the selection no longer names it. Each has its pair with no switch.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
const spies = vi.hoisted(() => ({
  update: vi.fn(async (..._a: unknown[]) => 'written' as const),
  meta: vi.fn(async (..._a: unknown[]) => {}),
}))
vi.mock('./vault-local', async (orig) => ({ ...(await orig<typeof import('./vault-local')>()), readLocal: async () => ({ s: 'absent' as const }), updateLocal: spies.update }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), updateVaultMeta: spies.meta, listVaults: async () => [] }))
const fetched = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200 }))
vi.stubGlobal('fetch', fetched)
const api = await import('./api')
const { pushRecentPayee } = await import('./recent-payees')
const { refusalError, refusalFromError } = await import('./shown-vault')

const SEL = 'konclave.selectedVault'
const NU = 'u1' + 'e'.repeat(76)
beforeEach(() => { localStorage.setItem(SEL, 'X'); spies.update.mockClear(); spies.meta.mockClear(); fetched.mockClear() })

describe('a write names the vault it is given', () => {
  it('m2 deleting a person: a shown id other than the selection writes nothing and says why', async () => {
    localStorage.setItem(SEL, 'Y')
    expect(await api.deleteBeneficiary('X', 'p1')).toEqual({ ok: false, error: 'vault changed' })
    expect(spies.update).not.toHaveBeenCalled()
  })
  it('m2 pair: with no switch it writes to the shown vault', async () => {
    expect(await api.deleteBeneficiary('X', 'p1')).toEqual({ ok: true })
    expect(spies.update).toHaveBeenCalledWith('X', 'benef', expect.any(Function))
  })
  it('gone: with no vault open, adding and deleting a person say so and write nothing', async () => {
    localStorage.removeItem(SEL)
    expect(await api.addBeneficiary('X', 'Nuria', NU, '')).toMatchObject({ ok: false, error: 'vault gone' })
    expect(await api.deleteBeneficiary('X', 'p1')).toEqual({ ok: false, error: 'vault gone' })
    expect(spies.update).not.toHaveBeenCalled()
  })
  it('m4 adopting a name after a switch records nothing', async () => {
    localStorage.setItem(SEL, 'Y')
    expect(await api.adoptSelfName('X', 'Bia')).toEqual({ error: 'vault changed' })
    expect(spies.meta).not.toHaveBeenCalled()
  })
  it('m4 pair: with no switch the name is recorded for the shown vault', async () => {
    expect(await api.adoptSelfName('X', 'Bia')).toEqual({ ok: true })
    expect(spies.meta).toHaveBeenCalledWith('X', { myName: 'Bia' })
  })
  it('m6 a recent payee after a switch is not kept, and with no switch it is', async () => {
    localStorage.setItem(SEL, 'Y')
    await pushRecentPayee('X', NU)
    expect(spies.update).not.toHaveBeenCalled()
    localStorage.setItem(SEL, 'X')
    await pushRecentPayee('X', NU)
    expect(spies.update).toHaveBeenCalledWith('X', 'recent', expect.any(Function))
  })
  it('the refusal strings have one producer and one reader', () => {
    expect(refusalError({ gone: true })).toBe('vault gone')
    expect(refusalError({})).toBe('vault changed')
    expect(refusalFromError('vault gone')).toEqual({ gone: true })
    expect(refusalFromError('vault changed')).toEqual({})
    expect(refusalFromError('something else')).toBeNull()
    expect(refusalFromError(undefined)).toBeNull()
  })
})
