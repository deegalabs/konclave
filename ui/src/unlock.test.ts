import { describe, expect, it } from 'vitest'
import { unlockWith, type UnlockDeps } from './unlock'

const ID = 'a'.repeat(64)

function deps(over: Partial<UnlockDeps> = {}) {
  const calls: string[] = []
  const base = {
    calls,
    loadVault: async (id: string, pass: string) => {
      if (pass !== 'right') throw new Error('seal refused')
      calls.push(`loadVault:${id}`)
      return { share: 'S' } as never
    },
    setUnlockedShare: (id: string) => { calls.push(`setUnlockedShare:${id}`) },
    markVaultUnlocked: (id: string) => { calls.push(`markVaultUnlocked:${id}`) },
    unlockVault: async () => ({ ok: true }) as never,
    registerThisDevice: async (id: string) => { calls.push(`registerThisDevice:${id}`); return true },
  }
  return { ...base, ...over } as UnlockDeps & { calls: string[] }
}

describe('unlockOnDevice', () => {
  // The whole reason the helper's reads work after an unlock. A version that marked the vault
  // unlocked WITHOUT putting the share in the session would pass every "is it unlocked" check and
  // then 401 on every private read - the blank-screen failure #439 exists to prevent, arrived at
  // from the other direction.
  it('puts the share in the session, not just a flag', async () => {
    const d = deps()
    expect(await unlockWith(d, ID, 'net', 'right')).toEqual({ ok: true })
    expect(d.calls).toContain(`setUnlockedShare:${ID}`)
    expect(d.calls).toContain(`markVaultUnlocked:${ID}`)
  })

  it('reports a wrong passphrase as wrong', async () => {
    const d = deps()
    expect(await unlockWith(d, ID, 'net', 'nope')).toEqual({ ok: false, wrong: true })
    expect(d.calls).toEqual([]) // nothing entered the session on a failure
  })

  it('refuses an empty passphrase without touching storage', async () => {
    const d = deps()
    expect(await unlockWith(d, ID, 'net', '')).toEqual({ ok: false, wrong: true })
    expect(d.calls).toEqual([])
  })

  // The distinction that exists so the product does not blame the member for the bridge being down.
  // Collapsing this to `wrong: true` would send someone hunting for a passphrase mistake they did
  // not make - on a vault where the passphrase is the only key to their share.
  it('does not call a bridge failure a wrong passphrase', async () => {
    const d = deps({ unlockVault: async () => ({ ok: false, wrong: false }) as never })
    expect(await unlockWith(d, ID, 'local', 'anything')).toEqual({ ok: false, wrong: false })
  })

  it('passes a bridge rejection through as wrong', async () => {
    const d = deps({ unlockVault: async () => ({ ok: false, wrong: true }) as never })
    expect(await unlockWith(d, ID, 'local', 'anything')).toEqual({ ok: false, wrong: true })
  })

  // #288's write key decides whether this member can VOTE AT ALL, and it used to register inside
  // the background signer - which only runs while a proposal is OPEN. That is a deadlock, not a
  // delay: acting on a proposal is what the key is for, so a seat that had not registered before
  // the vault's write gate came on could never register and could never vote. A live 2-of-3 vault
  // spent a fortnight there, with one member's seat absent from the coordinator's key list and
  // nothing anywhere saying so.
  //
  // Unlocking is the moment the claim the registration makes - this device holds its share - is
  // actually true, so it belongs here and the test says so.
  it('registers this seat with the coordinator, because unlocking is when it can', async () => {
    const d = deps()
    await unlockWith(d, ID, 'net', 'right')
    expect(d.calls).toContain(`registerThisDevice:${ID}`)
  })

  it('does not wait on the network, and a failed registration does not fail the unlock', async () => {
    // The member can already read and sign locally; blocking on the coordinator would make an
    // offline moment look like a wrong passphrase.
    //
    // This test does DOUBLE DUTY, and the second job is the one worth naming: the rejection it
    // throws must not escape. A bare `void promise` leaves an unhandled rejection behind, which
    // vitest reports as an error ALONGSIDE a green "634 passed" - so it is invisible to anyone
    // grepping for failures. That is exactly how it shipped once; CI caught it, a local run had
    // not. Keep the throw.
    const d = deps({ registerThisDevice: async () => { throw new Error('offline') } })
    expect(await unlockWith(d, ID, 'net', 'right')).toEqual({ ok: true })
  })

  it('does not register on the desktop-bridge path, which holds no share here', async () => {
    const d = deps()
    await unlockWith(d, ID, 'local', 'anything')
    expect(d.calls.some((c) => c.startsWith('registerThisDevice'))).toBe(false)
  })
})
