// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'

// P0A T3. Outside the browser-native app (the local bridge, the desktop shell) the device's record
// does not decide: the bridge answers with its own `locked`, so the function says nothing.
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), IS_NET: false }))

const { saveVault, deleteVault } = await import('./storage')
const { localLockNow } = await import('./vault-readable')
const GK = 'ef'.repeat(32)

describe('localLockNow outside the browser-native app (P0A T3)', () => {
  afterEach(async () => { await deleteVault(GK).catch(() => {}) })
  it('answers undefined even for a protected record the device holds', async () => {
    await saveVault(GK, {
      name: 'Treasury', governance: 'quorum', myName: 'Ana', creatorName: 'Ana',
      groupKey: new Uint8Array(32).fill(0xef), address: 'u1test', roster: ['Ana', 'Bia'],
      sealedShare: new Uint8Array(32).fill(1), accessSecret: new Uint8Array(32).fill(9),
    }, 'river stone maple lantern')
    expect(await localLockNow(GK)).toBeUndefined()
  })
})
