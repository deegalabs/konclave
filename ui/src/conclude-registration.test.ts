import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { codeOf } from './source-scan'

// Finishing a vault's registration with the coordinator, from the device's own record: the one
// implementation the end of a creation and the vault card both call (REG-RESUME).
const h = vi.hoisted(() => ({
  configured: true,
  failure: null as { status: number; error?: string; updateRequired?: boolean } | null,
  served: { vault_id: 'x', address: 'u1served', threshold: 2, total: 2 } as unknown,
  registerVault: vi.fn(),
  setMembers: vi.fn(async () => ['a', 'b']),
  registerThisDevice: vi.fn(async () => true),
  listVaults: vi.fn(),
  updateVaultMeta: vi.fn(async () => {}),
  getUnlockedShare: vi.fn(),
  setUnlockedShare: vi.fn(),
}))
vi.mock('./helper', async (orig) => ({
  ...(await orig<typeof import('./helper')>()),
  helperConfigured: () => h.configured,
  registerVault: h.registerVault,
  setMembers: h.setMembers,
  lastHelperPostFailure: () => h.failure,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: h.listVaults, updateVaultMeta: h.updateVaultMeta }))
vi.mock('./session', async (orig) => ({ ...(await orig<typeof import('./session')>()), getUnlockedShare: h.getUnlockedShare, setUnlockedShare: h.setUnlockedShare }))
vi.mock('./device-registration', () => ({ registerThisDevice: h.registerThisDevice }))

const { concludeRegistration, refusalKey } = await import('./conclude-registration')
const { isCurrentFlow, sameCoordinator } = await import('./creation-protocol')

const GK = 'ab'.repeat(32)
const rec = (over: Record<string, unknown> = {}) => ({
  id: GK, name: 'Team fund', groupKey: GK, address: '', roster: ['Ana', 'Bo'], createdAt: 1,
  pending: true, threshold: 2, total: 2, cp: 2, ...over,
})
// A session copy as the live creation holds it: no quorum on it.
const session = () => ({ groupKey: new Uint8Array(32), sealedShare: new Uint8Array(1), accessSecret: new Uint8Array(32), address: '', roster: ['Ana', 'Bo'], createdAt: 0 })

beforeEach(() => {
  vi.clearAllMocks()
  h.configured = true
  h.failure = null
  h.served = { vault_id: GK, address: 'u1served', threshold: 2, total: 2 }
  h.registerVault.mockImplementation(async () => h.served)
  h.listVaults.mockResolvedValue([rec()])
  h.getUnlockedShare.mockReturnValue(session())
})

describe('concludeRegistration reads the persisted record', () => {
  it('registers with the record\'s name, group key, quorum and protocol, and registers the device with the RECORD\'s quorum', async () => {
    const r = await concludeRegistration(GK)
    expect(r).toEqual({ address: 'u1served' })
    expect(h.registerVault).toHaveBeenCalledWith(GK, 'Team fund', 2, 2, 2)
    // The session copy has no quorum; without the record's the read key would not be registered.
    expect(h.registerThisDevice).toHaveBeenCalledWith(GK, expect.objectContaining({ threshold: 2, total: 2 }))
    expect(h.setMembers).toHaveBeenCalledWith(GK, ['Ana', 'Bo'])
  })
  it('the name falls back to net-<first 8 of the key> once, here', async () => {
    h.listVaults.mockResolvedValue([rec({ name: undefined })])
    await concludeRegistration(GK)
    expect(h.registerVault).toHaveBeenCalledWith(GK, `net-${GK.slice(0, 8)}`, 2, 2, 2)
  })
  it('sends the record\'s cp, never the app\'s: a v0.12.0-shaped record (quorum, no cp) sends 2', async () => {
    h.listVaults.mockResolvedValue([rec({ cp: undefined })])
    await concludeRegistration(GK)
    expect((h.registerVault.mock.calls[0] as unknown[])[4]).toBe(2)
    h.registerVault.mockClear()
    h.listVaults.mockResolvedValue([rec({ cp: 1 })])
    await concludeRegistration(GK)
    expect((h.registerVault.mock.calls[0] as unknown[])[4]).toBe(1)
  })
})

describe('what it writes', () => {
  it('only the address depositAddress approved, clearing pending, and the unlocked copy follows', async () => {
    await concludeRegistration(GK)
    expect(h.updateVaultMeta).toHaveBeenCalledTimes(1)
    expect(h.updateVaultMeta).toHaveBeenCalledWith(GK, { pending: false, address: 'u1served' })
    expect(h.setUnlockedShare).toHaveBeenCalledWith(GK, expect.objectContaining({ address: 'u1served' }))
  })
  it('a coordinator holding another quorum is not adopted: mismatch, record untouched', async () => {
    h.served = { vault_id: GK, address: 'u1served', threshold: 1, total: 2 }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'mismatch' })
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
    expect(h.registerThisDevice).not.toHaveBeenCalled()
  })
  it('an answer with no address text is not adopted either', async () => {
    h.served = { vault_id: GK, address: { oops: 1 }, threshold: 2, total: 2 }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'mismatch' })
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
  })
})

describe('each refusal keeps the record and says its own thing', () => {
  const kept = () => expect(h.updateVaultMeta).not.toHaveBeenCalled()
  it('unreachable: the network failed (no answer, no status)', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = null
    expect(await concludeRegistration(GK)).toEqual({ refused: 'unreachable' })
    kept()
  })
  it('update: the coordinator asks for a newer app', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = { status: 409, updateRequired: true }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'update', older: false })
    kept()
  })
  it('update on a record made by an older creation than this app speaks says so (a newer app would not help)', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = { status: 409, updateRequired: true }
    h.listVaults.mockResolvedValue([rec({ cp: 1 })])
    expect(await concludeRegistration(GK)).toEqual({ refused: 'update', older: true })
  })
  it('rejected: any other 4xx, with its status (a 429 is told apart so the screen can say try again)', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = { status: 429 }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'rejected', status: 429 })
    h.failure = { status: 400, error: 'bad' }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'rejected', status: 400 })
    kept()
  })
})

describe('the address that is written', () => {
  it('is the recorded one when the record already has an address: the record wins, and the served one is ignored', async () => {
    h.listVaults.mockResolvedValue([rec({ address: 'u1recorded' })])
    expect(await concludeRegistration(GK)).toEqual({ address: 'u1recorded' })
    expect(h.updateVaultMeta).toHaveBeenCalledWith(GK, { pending: false, address: 'u1recorded' })
  })
  it('goes through addressText: surrounding whitespace is not written', async () => {
    h.served = { vault_id: GK, address: '  u1served \n', threshold: 2, total: 2 }
    expect(await concludeRegistration(GK)).toEqual({ address: 'u1served' })
    expect(h.updateVaultMeta).toHaveBeenCalledWith(GK, { pending: false, address: 'u1served' })
    expect(h.setUnlockedShare).toHaveBeenCalledWith(GK, expect.objectContaining({ address: 'u1served' }))
  })
  it('is refused when the coordinator answers about another vault', async () => {
    h.served = { vault_id: 'cd'.repeat(32), address: 'u1other', threshold: 2, total: 2 }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'mismatch' })
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
    expect(h.registerThisDevice).not.toHaveBeenCalled()
  })
})

describe('a device with no share in session registers nothing', () => {
  it('locked: no network, no writes (a passkey unlock seats only the read secret)', async () => {
    h.getUnlockedShare.mockReturnValue(undefined)
    expect(await concludeRegistration(GK)).toEqual({ refused: 'locked' })
    expect(h.registerVault).not.toHaveBeenCalled()
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
    expect(h.registerThisDevice).not.toHaveBeenCalled()
  })
})

describe('a 5xx is the network\'s case, a 4xx is the coordinator saying no', () => {
  it('500, 502, 503 are unreachable; 400, 403, 404, 429 are rejected', async () => {
    h.registerVault.mockResolvedValue(null)
    for (const status of [500, 502, 503]) {
      h.failure = { status }
      expect(await concludeRegistration(GK)).toEqual({ refused: 'unreachable' })
    }
    for (const status of [400, 403, 404, 429]) {
      h.failure = { status }
      expect(await concludeRegistration(GK)).toEqual({ refused: 'rejected', status })
    }
  })
})

describe('one definition of a record of the current creation flow', () => {
  it('needs the protocol AND the quorum: by behaviour, not by the shape of its source', async () => {
    expect(isCurrentFlow({ cp: 2, threshold: 2, total: 3 })).toBe(true)
    expect(isCurrentFlow({ threshold: 2, total: 3 })).toBe(true) // v0.12.0 shape
    expect(isCurrentFlow({ cp: 2 })).toBe(false) // a protocol with no quorum
    expect(isCurrentFlow({ cp: 2, threshold: 2 })).toBe(false)
    expect(isCurrentFlow({})).toBe(false)
    // and the registration agrees with it: a record it calls old is never registered
    h.listVaults.mockResolvedValue([rec({ total: undefined })])
    expect(await concludeRegistration(GK)).toEqual({ refused: 'old' })
    expect(h.registerVault).not.toHaveBeenCalled()
  })
  it('resumable, the card and the registration read that one function', () => {
    expect(codeOf('./creation-protocol.ts')).toMatch(/return isCurrentFlow\(r\) &&/)
    expect(codeOf('./conclude-registration.ts')).toMatch(/!isCurrentFlow\(rec\)/)
    expect(codeOf('./screens/Vaults.tsx')).toMatch(/oldFlow = !!rec && !isCurrentFlow\(rec\)/)
  })
})

describe('the coordinator in use against the recorded one', () => {
  it('same when nothing was recorded or the two agree; different otherwise', () => {
    expect(sameCoordinator(undefined, 'https://a')).toBe(true)
    expect(sameCoordinator('', 'https://a')).toBe(true)
    expect(sameCoordinator('https://a', 'https://a')).toBe(true)
    expect(sameCoordinator('https://a', 'https://b')).toBe(false)
  })
})

describe('refusalKey: one distinct key per refusal', () => {
  it('no two causes share a sentence, and every key is in both dictionaries', async () => {
    const { en } = await import('./i18n/en')
    const { ptBR } = await import('./i18n/pt-BR')
    const keys = [
      refusalKey({ refused: 'old' }),
      refusalKey({ refused: 'locked' }),
      refusalKey({ refused: 'update', older: false }),
      refusalKey({ refused: 'update', older: true }),
      refusalKey({ refused: 'mismatch' }),
      refusalKey({ refused: 'unreachable' }),
      refusalKey({ refused: 'rejected', status: 400 }),
      refusalKey({ refused: 'rejected', status: 429 }),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) { expect(en[k], k).toBeTruthy(); expect(ptBR[k], k).toBeTruthy() }
    expect(refusalKey({ refused: 'unreachable' })).toBe('registration.unreachable')
    expect(refusalKey({ refused: 'mismatch' })).toBe('net.err.registrationMismatch')
  })
  it('the creation shows exactly that key', () => {
    expect(codeOf('./screens/NetVault.tsx')).toMatch(/setHostedState\('failed'\)\s*setError\(tt\(refusalKey\(r\)\)\)/)
  })
})

describe('an old-flow record is refused before any network', () => {
  it('no quorum and no protocol: old, and registerVault is never called', async () => {
    h.listVaults.mockResolvedValue([rec({ cp: undefined, threshold: undefined, total: undefined })])
    expect(await concludeRegistration(GK)).toEqual({ refused: 'old' })
    expect(h.registerVault).not.toHaveBeenCalled()
    expect(h.setMembers).not.toHaveBeenCalled()
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
  })
  it('a vault this device has no record of is old too', async () => {
    h.listVaults.mockResolvedValue([])
    expect(await concludeRegistration(GK)).toEqual({ refused: 'old' })
    expect(h.registerVault).not.toHaveBeenCalled()
  })
})

describe('the pins', () => {
  const mentions = (word: RegExp, strip?: RegExp) => {
    const out: string[] = []
    const walk = (sub: string) => {
      for (const e of readdirSync(new URL(sub, new URL('./', import.meta.url)), { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== 'wasm-pkg') walk(`${sub}${e.name}/`) }
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          let src = codeOf(`./${sub}${e.name}`)
          if (strip) src = src.replace(strip, '')
          if (word.test(src)) out.push(`${sub}${e.name}`)
        }
      }
    }
    walk('')
    return out.sort()
  }
  it('registerVault is called in conclude-registration.ts and nowhere else', () => {
    expect(mentions(/\bregisterVault\b/, /export async function registerVault\(/)).toEqual(['conclude-registration.ts'])
  })
  it('concludeRegistration is called only from NetVault.tsx and Vaults.tsx', () => {
    expect(mentions(/\bconcludeRegistration\b/)).toEqual(['conclude-registration.ts', 'screens/NetVault.tsx', 'screens/Vaults.tsx'])
  })
  it('registerVault has no default for cp (or for anything): the caller names the protocol', () => {
    const src = codeOf('./helper.ts')
    const sig = src.slice(src.indexOf('export async function registerVault('), src.indexOf('): Promise<HelperVault | null>'))
    expect(sig).toMatch(/cp: number/)
    expect(sig).not.toMatch(/=/)
    expect(sig).not.toMatch(/CREATION_PROTOCOL/)
  })
  it('no screen writes an address onto a record itself: only the function does', () => {
    for (const f of ['./screens/NetVault.tsx', './screens/Vaults.tsx']) expect(codeOf(f)).not.toMatch(/updateVaultMeta\([^)]*address/)
  })
})
