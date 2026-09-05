import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import {
  saveVault, loadVault, listVaults, deleteVault, forgetVault, storageAvailable,
  exportVault, importVault, parseVaultExport, type VaultData,
  warnsAboutEviction, storagePersistence,
} from './storage'

// Covers the on-device share persistence (Marco 5): the encrypted IndexedDB round-trip that
// `storage.ts` performs. fake-indexeddb provides IndexedDB; Node's WebCrypto provides
// AES-GCM/PBKDF2 (crypto.subtle). The point is that a saved share comes back only with the
// right passphrase, never in the clear.

const share = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1))
const groupKey = new Uint8Array(32).fill(7)
const data: VaultData = {
  name: 'Test vault', governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey, address: 'u1examplevaultaddress', roster: ['Alice', 'Bob', 'Carol'], sealedShare: share,
}

describe('storage - encrypted IndexedDB persistence', () => {
  it('is available in the test environment (IndexedDB + WebCrypto)', () => {
    expect(storageAvailable()).toBe(true)
  })

  it('round-trips: save then load with the right passphrase recovers the sealed share and metadata', async () => {
    await saveVault('v1', data, 'correct horse battery staple')
    const loaded = await loadVault('v1', 'correct horse battery staple')
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
    expect(Array.from(loaded.groupKey)).toEqual(Array.from(groupKey))
    expect(loaded.address).toBe('u1examplevaultaddress')
    expect(loaded.roster).toEqual(['Alice', 'Bob', 'Carol'])
    expect(loaded.createdAt).toBeGreaterThan(0)
  })

  it('rejects a wrong passphrase (AES-GCM authentication fails)', async () => {
    await saveVault('v2', data, 'right-passphrase')
    await expect(loadVault('v2', 'wrong-passphrase')).rejects.toThrow(/wrong passphrase|tampered/i)
  })

  it('listVaults exposes only public metadata - never the secret share', async () => {
    const list = await listVaults()
    const v = list.find((x) => x.id === 'v1')
    expect(v).toBeTruthy()
    expect(v).not.toHaveProperty('sealedShare')
    expect(Object.keys(v!).sort()).toEqual(['address', 'createdAt', 'creatorName', 'governance', 'groupKey', 'id', 'myName', 'name', 'roster', 'secured'])
    expect(v!.name).toBe('Test vault')
    expect(v!.governance).toBe('quorum')
    expect(v!.myName).toBe('Alice')
    expect(v!.creatorName).toBe('Alice')
    // The 1..32 share bytes must not leak through the public metadata.
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(Array.from(share)))
  })

  it('lists and deletes a vault; a deleted vault cannot be loaded', async () => {
    await saveVault('v3', data, 'p')
    expect((await listVaults()).map((x) => x.id)).toContain('v3')
    await deleteVault('v3')
    expect((await listVaults()).map((x) => x.id)).not.toContain('v3')
    await expect(loadVault('v3', 'p')).rejects.toThrow(/no saved vault/i)
  })

  it('requires an id and a passphrase to save', async () => {
    await expect(saveVault('', data, 'p')).rejects.toThrow(/id is required/i)
    await expect(saveVault('x', data, '')).rejects.toThrow(/passphrase is required/i)
  })
})

describe('storage - portable vault export/import (v2 opaque + v1 compat, #214/#388)', () => {
  const pass = 'move-me-to-another-device'
  const shareHex = share.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')

  it('exports a v2 opaque blob that leaks no metadata or share', async () => {
    await saveVault('exp1', data, pass)
    const bundle = await exportVault('exp1', pass)
    expect(bundle.format).toBe('konclave-vault-export')
    expect(bundle.version).toBe(2)
    expect(bundle).not.toHaveProperty('vault')
    expect(bundle.cipher.length).toBeGreaterThan(0)
    // Nothing sensitive is in the clear: not the share, the group key, the address, member names, or id.
    const json = JSON.stringify(bundle)
    expect(json).not.toContain(shareHex)
    expect(json).not.toContain('07'.repeat(32))
    expect(json).not.toContain('u1examplevaultaddress')
    expect(json).not.toContain('Alice')
    expect(json).not.toContain('exp1')
  })

  it('export rejects a wrong passphrase', async () => {
    await saveVault('exp2', data, pass)
    await expect(exportVault('exp2', 'nope')).rejects.toThrow(/wrong passphrase|tampered/i)
  })

  it('v2 round-trips across a fresh device: export -> delete -> import -> load (with S)', async () => {
    const accessSecret = new Uint8Array(32).fill(5)
    await saveVault('exp3', { ...data, accessSecret }, pass)
    const bundle = await exportVault('exp3', pass)
    const roundtripped = parseVaultExport(JSON.stringify(bundle)) // survives file/paste serialization
    await deleteVault('exp3') // simulate a new device with no record
    expect((await listVaults()).map((x) => x.id)).not.toContain('exp3')

    const meta = await importVault(roundtripped, pass)
    expect(meta.id).toBe('exp3')
    expect(meta.name).toBe('Test vault')
    expect(meta.secured).toBe(true)

    const loaded = await loadVault('exp3', pass)
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
    expect(Array.from(loaded.groupKey)).toEqual(Array.from(groupKey))
    expect(loaded.roster).toEqual(['Alice', 'Bob', 'Carol'])
    expect(Array.from(loaded.accessSecret!)).toEqual(Array.from(accessSecret))
  })

  it('import rejects a wrong passphrase before writing anything', async () => {
    await saveVault('exp4', data, pass)
    const bundle = await exportVault('exp4', pass)
    await deleteVault('exp4')
    await expect(importVault(bundle, 'wrong')).rejects.toThrow(/wrong passphrase/i)
    expect((await listVaults()).map((x) => x.id)).not.toContain('exp4')
  })

  it('import refuses to overwrite an existing vault unless overwrite is set', async () => {
    await saveVault('exp5', data, pass)
    const bundle = await exportVault('exp5', pass)
    await expect(importVault(bundle, pass)).rejects.toThrow(/already exists/i)
    const meta = await importVault(bundle, pass, { overwrite: true })
    expect(meta.id).toBe('exp5')
  })

  it('carries the beneficiaries through v2 export -> import, sealed', async () => {
    const store = new Map<string, string>()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
    } as Storage
    const payees = [{ id: 'p1', name: 'Rent', address: 'u1rentpayee', memo: '', is_public: false }]
    store.set('konclave.benef.exp6', JSON.stringify(payees))
    await saveVault('exp6', data, pass)
    const bundle = await exportVault('exp6', pass)
    expect(JSON.stringify(bundle)).not.toContain('u1rentpayee') // sealed, not cleartext
    store.clear()
    await deleteVault('exp6')
    await importVault(bundle, pass)
    expect(JSON.parse(store.get('konclave.benef.exp6') ?? '[]')).toEqual(payees)
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  })

  it('still imports a legacy v1 bundle (backward compat)', async () => {
    // Build a v1 bundle by hand: cipher = AES-GCM(passphrase) of the share, as v1 stored it.
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, share))
    const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    const v1 = { format: 'konclave-vault-export', version: 1, exportedAt: Date.now(), vault: { id: 'v1imp', name: 'Legacy', groupKey: hx(groupKey), address: 'u1legacy', roster: ['A', 'B'], createdAt: 111, salt: hx(salt), iv: hx(iv), cipher: hx(cipher) } }
    const parsed = parseVaultExport(JSON.stringify(v1))
    const meta = await importVault(parsed, pass)
    expect(meta.id).toBe('v1imp')
    expect(meta.secured).toBe(false) // a v1 export has no S
    expect(Array.from((await loadVault('v1imp', pass)).sealedShare)).toEqual(Array.from(share))
  })

  it('parseVaultExport accepts v2, rejects junk, foreign JSON, and unknown versions', () => {
    expect(() => parseVaultExport('not json')).toThrow(/not valid JSON|not a Konclave/i)
    expect(() => parseVaultExport(JSON.stringify({ format: 'something-else' }))).toThrow(/not a Konclave/i)
    expect(() => parseVaultExport(JSON.stringify({ format: 'konclave-vault-export', version: 2 }))).toThrow(/incomplete|corrupt/i)
    expect(() => parseVaultExport(JSON.stringify({ format: 'konclave-vault-export', version: 9 }))).toThrow(/Unsupported/i)
  })
})

// The per-vault access secret S (#388): a fresh random secret every seated member holds and an
// id-only outsider does not, so a leaked vault id no longer opens the reads or the signing room.
// It is sealed at rest exactly like the share (encrypted under the passphrase, never in the clear),
// and it is OPTIONAL so vaults created before #388 still load.
describe('storage - per-vault access secret (#388)', () => {
  const accessSecret = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 100)) // 100..131

  it('round-trips the sealed access secret alongside the share', async () => {
    await saveVault('sec1', { ...data, accessSecret }, 'pw')
    const loaded = await loadVault('sec1', 'pw')
    expect(loaded.accessSecret).toBeDefined()
    expect(Array.from(loaded.accessSecret!)).toEqual(Array.from(accessSecret))
    // The share is unaffected.
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
  })

  it('a vault saved without an access secret loads with accessSecret undefined (pre-#388 compat)', async () => {
    await saveVault('sec2', data, 'pw') // no accessSecret
    const loaded = await loadVault('sec2', 'pw')
    expect(loaded.accessSecret).toBeUndefined()
  })

  it('listVaults reports whether a vault is secured (has S) - never the secret itself', async () => {
    await saveVault('secured1', { ...data, accessSecret }, 'pw')
    await saveVault('open1', data, 'pw') // no accessSecret -> legacy/open vault
    const list = await listVaults()
    expect(list.find((v) => v.id === 'secured1')?.secured).toBe(true)
    expect(list.find((v) => v.id === 'open1')?.secured).toBe(false)
  })

  it('never leaks the access secret bytes into public metadata', async () => {
    await saveVault('sec3', { ...data, accessSecret }, 'pw')
    const v = (await listVaults()).find((x) => x.id === 'sec3')
    expect(v).toBeTruthy()
    const secretHex = accessSecret.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(Array.from(accessSecret)))
    expect(JSON.stringify(v)).not.toContain(secretHex)
  })
})

// #307: the browser's answer to "will you keep this?" was requested and thrown away at both call
// sites, so a member on a browser that declines could lose their share to eviction and never be
// told. These cover the decision that fixes it, including the case the old code got wrong by
// omission: not knowing.
describe('storage persistence - #307, a refusal must not be silent', () => {
  it('says nothing when the browser granted persistence', () => {
    expect(warnsAboutEviction('persisted')).toBe(false)
  })

  it('warns when the browser refused', () => {
    // Safari is the live case: it usually declines, and clears after ~7 days of inactivity.
    expect(warnsAboutEviction('evictable')).toBe(true)
  })

  it('warns when it cannot tell, because not knowing is not the same as safe', () => {
    // A browser with no Storage API cannot promise anything, so it offers no guarantee either.
    // The costs are not symmetric: a missed warning loses a key share, a false one is a banner
    // someone reads twice. This is the same fail-closed rule the propose gate follows.
    expect(warnsAboutEviction('unknown')).toBe(true)
  })

  it('reports unknown when the browser has no Storage API at all', async () => {
    await expect(storagePersistence({} as Navigator)).resolves.toBe('unknown')
  })

  it('reports persisted without asking again when it is already granted', async () => {
    let asked = false
    const nav = {
      storage: {
        persisted: async () => true,
        persist: async () => { asked = true; return false },
      },
    } as unknown as Navigator
    await expect(storagePersistence(nav)).resolves.toBe('persisted')
    expect(asked, 'an already-persisted origin must not be re-prompted').toBe(false)
  })

  it('reports evictable when the browser refuses the request', async () => {
    const nav = {
      storage: { persisted: async () => false, persist: async () => false },
    } as unknown as Navigator
    await expect(storagePersistence(nav)).resolves.toBe('evictable')
  })

  it('reports unknown when the API throws, rather than claiming either answer', async () => {
    const nav = {
      storage: { persisted: async () => { throw new Error('blocked') }, persist: async () => false },
    } as unknown as Navigator
    await expect(storagePersistence(nav)).resolves.toBe('unknown')
  })
})

describe("forgetVault - removing this device's copy (#426)", () => {
  it('removes the record and reports that it is really gone', async () => {
    await saveVault('forget-1', data, 'pass')
    expect((await listVaults()).some((v) => v.id === 'forget-1')).toBe(true)
    expect(await forgetVault('forget-1')).toBe(true)
    expect((await listVaults()).some((v) => v.id === 'forget-1')).toBe(false)
  })

  it('takes the sealed share with it - this device can no longer open the vault at all', async () => {
    // The whole point of the control: after it, this device cannot sign for the vault. If the
    // record survived, the share survived with it.
    await saveVault('forget-2', data, 'pass')
    await forgetVault('forget-2')
    await expect(loadVault('forget-2', 'pass')).rejects.toThrow()
  })

  it('reports FALSE when the delete did not take, instead of claiming success', async () => {
    // This is why it returns a boolean rather than void. `deleteVault` no-ops when storage is
    // unavailable and ignores the delete request's own result, so a caller that assumed success
    // would tell the member their share is off the device while it is still sitting there.
    // Here the store's delete is made into a no-op: the transaction still completes cleanly, and
    // only re-reading catches it.
    await saveVault('forget-3', data, 'pass')
    const realDelete = IDBObjectStore.prototype.delete
    IDBObjectStore.prototype.delete = (() => undefined) as unknown as typeof realDelete
    try {
      expect(await forgetVault('forget-3')).toBe(false)
    } finally {
      IDBObjectStore.prototype.delete = realDelete
    }
    // And it is still there - the test's premise, not just its conclusion.
    expect((await listVaults()).some((v) => v.id === 'forget-3')).toBe(true)
    expect(await forgetVault('forget-3')).toBe(true) // the real delete still works afterwards
  })
})
