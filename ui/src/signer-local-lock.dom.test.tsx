// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

// P0A T4. The signer provider reads its vault on mount; for a protected vault this device holds a
// record of and has not unlocked, it must not name it. After the overlay unlock (`unlockNonce`
// moves) it reads once.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
const getVault = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getVault }))
vi.mock('./useBackgroundSigner', () => ({
  useBackgroundSigner: () => ({ ready: false, phase: 'idle', error: '', what: null, setProposal: () => {}, unarm: async () => {} }),
}))

const { VaultSignerProvider } = await import('./VaultSigner')
const { saveVault, deleteVault } = await import('./storage')
const { setSelectedVault } = await import('./api')
const { setReadSecret, clearReadSecret } = await import('./session')

const ID = 'ab'.repeat(32)
beforeEach(async () => {
  setSelectedVault(ID)
  getVault.mockResolvedValue(null)
  await saveVault(ID, {
    name: 'Treasury', governance: 'quorum', myName: 'Ana', creatorName: 'Ana',
    groupKey: new Uint8Array(32).fill(0xab), address: 'u1test', roster: ['Ana', 'Bia'],
    sealedShare: new Uint8Array(32).fill(1), accessSecret: new Uint8Array(32).fill(9),
  }, 'river stone maple lantern')
  clearReadSecret(ID) // saving puts nothing in the session, this is the reload state
})
afterEach(async () => { cleanup(); vi.clearAllMocks(); clearReadSecret(ID); await deleteVault(ID).catch(() => {}) })

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)) })

describe('the signer provider does not name a locked vault (P0A T4)', () => {
  it('reads nothing while locked, and once after the unlock nonce moves', async () => {
    const ui = (n: number) => <VaultSignerProvider vaultId={ID} unlockNonce={n}><span /></VaultSignerProvider>
    const { rerender } = render(ui(0))
    await settle()
    expect(getVault).not.toHaveBeenCalled()
    setReadSecret(ID, new Uint8Array(32).fill(9))
    rerender(ui(1))
    await settle()
    expect(getVault).toHaveBeenCalledTimes(1)
    // The id it checked is the id it asks for: the selection other tabs share can move between the two.
    expect(getVault).toHaveBeenCalledWith(ID)
  })
})
