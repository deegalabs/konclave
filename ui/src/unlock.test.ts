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
})
