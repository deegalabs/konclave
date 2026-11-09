import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { codeOf } from './source-scan'

// Finishing a vault's registration with the coordinator, from the device's own record: the one
// implementation the end of a creation and the vault card both call (REG-RESUME).
const h = vi.hoisted(() => ({
  configured: true,
  failure: null as { status: number; error?: string; code?: string; updateRequired?: boolean } | null,
  served: { vault_id: 'x', address: 'u1served', threshold: 2, total: 2 } as unknown,
  registerVault: vi.fn(),
  getVault: vi.fn(),
  adopt: vi.fn(),
  digest: 'd1',
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
  getVault: h.getVault,
  setMembers: h.setMembers,
  lastHelperPostFailure: () => h.failure,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: h.listVaults, updateVaultMeta: h.updateVaultMeta }))
vi.mock('./session', async (orig) => ({ ...(await orig<typeof import('./session')>()), getUnlockedShare: h.getUnlockedShare, setUnlockedShare: h.setUnlockedShare }))
vi.mock('./vault-receivers', () => ({ adoptVaultReceivers: h.adopt }))
vi.mock('./pin-digest', () => ({ ownPkpDigest: async () => h.digest }))
vi.mock('./device-registration', () => ({ registerThisDevice: h.registerThisDevice }))

const { concludeRegistration, refusalKey } = await import('./conclude-registration')
const { recordRead } = await import('./read-failure')
const { isCurrentFlow, sameCoordinator, CREATION_PROTOCOL } = await import('./creation-protocol')

const GK = 'ab'.repeat(32)
const BUNDLE = JSON.stringify({ pkp: 'aa', proofs: [] })
const rec3 = (over: Record<string, unknown> = {}) => rec({ cp: 3, pinBundle: BUNDLE, ...over })
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
  h.digest = 'd1'
  h.adopt.mockImplementation(async () => ({ state: 'verified', address: 'u1served' }))
  h.served = { vault_id: GK, address: 'u1served', threshold: 2, total: 2, state: 'pinned', pkp_digest: 'd1' }
  h.getVault.mockResolvedValue(null)
  h.registerVault.mockImplementation(async () => h.served)
  h.listVaults.mockResolvedValue([rec()])
  h.getUnlockedShare.mockReturnValue(session())
})

describe('concludeRegistration reads the persisted record', () => {
  it('registers with the record\'s name, group key, quorum and protocol, and registers the device with the RECORD\'s quorum', async () => {
    const r = await concludeRegistration(GK)
    expect(r).toEqual({ address: 'u1served' })
    expect(h.registerVault).toHaveBeenCalledWith(GK, 'Team fund', 2, 2, 2, undefined)
    // The session copy has no quorum; without the record's the read key would not be registered.
    expect(h.registerThisDevice).toHaveBeenCalledWith(GK, expect.objectContaining({ threshold: 2, total: 2 }))
    expect(h.setMembers).toHaveBeenCalledWith(GK, ['Ana', 'Bo'])
  })
  it('the name falls back to net-<first 8 of the key> once, here', async () => {
    h.listVaults.mockResolvedValue([rec({ name: undefined })])
    await concludeRegistration(GK)
    expect(h.registerVault).toHaveBeenCalledWith(GK, `net-${GK.slice(0, 8)}`, 2, 2, 2, undefined)
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
    h.listVaults.mockResolvedValue([rec3({ cp: CREATION_PROTOCOL })])
    expect(await concludeRegistration(GK)).toEqual({ refused: 'update', older: false })
    kept()
  })
  it('update on a record made by an older creation than this app speaks says so (a newer app would not help)', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = { status: 409, updateRequired: true }
    h.listVaults.mockResolvedValue([rec({ cp: 1 })])
    expect(await concludeRegistration(GK)).toEqual({ refused: 'update', older: true })
  })
  it('a code the coordinator names is what the member is told, and an unknown one is not trusted', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = { status: 409, code: 'pin_package_differs' }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'coded', code: 'pin_package_differs' })
    h.failure = { status: 400, code: 'constructor' }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'rejected', status: 400 })
    h.failure = { status: 503, code: 'vault_unreadable' }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'coded', code: 'vault_unreadable' })
    kept()
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

describe('a record whose id is not its group key', () => {
  it('is old: said before the network, not as a quorum mismatch', async () => {
    h.listVaults.mockResolvedValue([rec({ groupKey: 'cd'.repeat(32) })])
    expect(await concludeRegistration(GK)).toEqual({ refused: 'old' })
    expect(h.registerVault).not.toHaveBeenCalled()
  })
})

describe('the address that is written', () => {
  it('is the recorded one when the record already has an address: the record wins, and the served one is ignored', async () => {
    h.listVaults.mockResolvedValue([rec({ address: 'u1recorded' })])
    expect(await concludeRegistration(GK)).toEqual({ address: 'u1recorded' })
    expect(h.updateVaultMeta).toHaveBeenCalledWith(GK, { pending: false, address: 'u1recorded' })
  })
  it('goes through addressText: surrounding whitespace is not written', async () => {
    h.served = { vault_id: GK, address: '  u1served \n', threshold: 2, total: 2, state: 'pinned', pkp_digest: 'd1' }
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
    expect(codeOf('./screens/Vaults.tsx')).toMatch(/oldFlow = !!rec && !isCurrentFlow\(rec\)\s*\n/)
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

describe('a vault of protocol 3', () => {
  beforeEach(() => { h.listVaults.mockResolvedValue([rec3()]) })
  it('without a bundle never posts, and finishes on a vault others pinned to this package', async () => {
    h.listVaults.mockResolvedValue([rec3({ pinBundle: undefined })])
    h.getVault.mockResolvedValue(h.served)
    expect(await concludeRegistration(GK)).toEqual({ address: 'u1served' })
    expect(h.registerVault).not.toHaveBeenCalled()
    expect(h.registerThisDevice).toHaveBeenCalled()
  })

  // A vault of an earlier pinning protocol that the coordinator already registered: the app moved on,
  // and the coordinator now asks for the newer one, but this vault exists and is pinned to this device's
  // package. Telling the member not to fund it would be false; it finishes like a device with no bundle.
  it('asked to update, a vault already pinned to this package finishes instead', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = { status: 403, updateRequired: true }
    h.getVault.mockResolvedValue(h.served)
    expect(await concludeRegistration(GK)).toEqual({ address: 'u1served' })
    expect(h.registerThisDevice).toHaveBeenCalled()
  })

  it('asked to update, a vault not pinned to this package still says update', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = { status: 403, updateRequired: true }
    for (const answer of [null, { ...(h.served as object), state: 'closed' }, { ...(h.served as object), pkp_digest: 'other' }]) {
      h.getVault.mockResolvedValue(answer)
      // The coordinator answered that it holds no such vault (404).
      recordRead('/api/vault', answer ? null : 'missing')
      expect(await concludeRegistration(GK)).toEqual({ refused: 'update', older: true })
    }
  })

  // The read that would tell whether the vault is pinned here did not get an answer: nothing is known,
  // so the member is not told the vault must not be funded; it is the network's case, and a retry decides.
  it('asked to update, a read that did not get an answer is the network, not "do not fund"', async () => {
    h.registerVault.mockResolvedValue(null)
    h.failure = { status: 403, updateRequired: true }
    h.getVault.mockResolvedValue(null)
    for (const reason of ['offline', 'timeout', 'unavailable', 'malformed'] as const) {
      recordRead('/api/vault', reason)
      expect(await concludeRegistration(GK)).toEqual({ refused: 'unreachable' })
    }
  })

  it('without a bundle stays refused on a vault not pinned, or pinned to another package', async () => {
    h.listVaults.mockResolvedValue([rec3({ pinBundle: undefined })])
    for (const answer of [null, { ...(h.served as object), state: 'closed' }, { ...(h.served as object), pkp_digest: 'other' }]) {
      h.getVault.mockResolvedValue(answer)
      expect(await concludeRegistration(GK)).toEqual({ refused: 'nobundle' })
    }
    expect(h.registerVault).not.toHaveBeenCalled()
    expect(h.registerThisDevice).not.toHaveBeenCalled()
  })

  it('takes no answer that is not pinned to the package this device holds', async () => {
    h.registerVault.mockImplementation(async () => ({ ...(h.served as object), pkp_digest: 'other' }))
    expect(await concludeRegistration(GK)).toEqual({ refused: 'mismatch' })
    h.registerVault.mockImplementation(async () => ({ ...(h.served as object), state: 'legacy' }))
    expect(await concludeRegistration(GK)).toEqual({ refused: 'mismatch' })
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
  })

  it('an abandoned creation is not finished, and no network is used', async () => {
    h.listVaults.mockResolvedValue([rec3({ abandoned: 'secretSplit' })])
    expect(await concludeRegistration(GK)).toEqual({ refused: 'abandoned' })
    expect(h.registerVault).not.toHaveBeenCalled()
  })
})

describe('a vault of protocol 3 is finished only when this device was taken', () => {
  beforeEach(() => { h.listVaults.mockResolvedValue([rec3()]) })
  it('a roster the coordinator refused does not finish it', async () => {
    h.setMembers.mockResolvedValueOnce(null as never)
    h.failure = { status: 400, code: 'roster_invalid' }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'coded', code: 'roster_invalid' })
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
  })
  it('a roster someone else already set is not a refusal: the banner is for that', async () => {
    h.setMembers.mockResolvedValueOnce(null as never)
    h.failure = { status: 409 }
    expect(await concludeRegistration(GK)).toEqual({ address: 'u1served' })
  })
  it('a read key or seat refused does not finish it, and says which', async () => {
    h.registerThisDevice.mockResolvedValueOnce({ refused: 'read_key_pinned' } as never)
    expect(await concludeRegistration(GK)).toEqual({ refused: 'coded', code: 'read_key_pinned' })
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
  })
  it('the live session copy, which has no protocol, registers as what the record says', async () => {
    await concludeRegistration(GK)
    expect(h.registerThisDevice).toHaveBeenCalledWith(GK, expect.objectContaining({ cp: 3 }))
    expect(h.adopt).toHaveBeenCalledWith(GK, expect.objectContaining({ cp: 3 }))
  })
  it('a coordinator out of reach at that moment does not undo it: a later unlock registers', async () => {
    h.registerThisDevice.mockResolvedValueOnce({ unreachable: true } as never)
    expect(await concludeRegistration(GK)).toEqual({ address: 'u1served' })
  })
})

describe('a vault of protocol 3 takes its address from its own key', () => {
  beforeEach(() => { h.listVaults.mockResolvedValue([rec3()]) })
  it('never the served address, and a refusal or no answer leaves it unfinished', async () => {
    h.adopt.mockResolvedValueOnce({ state: 'verified', address: 'u1derived' })
    expect(await concludeRegistration(GK)).toEqual({ address: 'u1derived' })
    expect(h.updateVaultMeta).toHaveBeenCalledWith(GK, { pending: false })
    vi.clearAllMocks()
    h.adopt.mockResolvedValueOnce({ state: 'refused' })
    expect(await concludeRegistration(GK)).toEqual({ refused: 'coded', code: 'address_mismatch' })
    h.adopt.mockResolvedValueOnce({ state: 'unavailable' })
    expect(await concludeRegistration(GK)).toEqual({ refused: 'unreachable' })
    expect(h.updateVaultMeta).not.toHaveBeenCalled()
  })
})

describe('protocol 3, the quorum the coordinator answers with', () => {
  it('another quorum is refused, and nothing is adopted', async () => {
    h.listVaults.mockResolvedValue([rec3()])
    h.getUnlockedShare.mockReturnValue(session())
    h.registerVault.mockResolvedValue({ vault_id: GK, threshold: 1, total: 2, state: 'pinned', pkp_digest: h.digest })
    h.getVault.mockResolvedValue({ vault_id: GK, threshold: 1, total: 2, state: 'pinned', pkp_digest: h.digest })
    h.served = { vault_id: GK, threshold: 1, total: 2, state: 'pinned', pkp_digest: h.digest }
    expect(await concludeRegistration(GK)).toEqual({ refused: 'mismatch' })
    expect(h.adopt).not.toHaveBeenCalled()
  })
})

