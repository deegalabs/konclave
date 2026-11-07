import 'fake-indexeddb/auto'
import { describe, it, expect, vi } from 'vitest'
// #669: this file derives keys (PBKDF2 at 600k rounds, AES-GCM) in most of its tests. Measured on
// an idle machine the slowest took 5.0 s, so under load they cross the 5 s default and read as a
// regression. The limit is raised for this file only; the global one in vite.config.ts stays.
vi.setConfig({ testTimeout: 30_000 })

import {
  saveVault, loadVault, listVaults, deleteVault, forgetVault, storageAvailable,
  exportVault, importVault, parseVaultExport, changePassphrase, recordChangeReceiver, updateVaultMeta, type VaultData,
  warnsAboutEviction, storagePersistence,
} from './storage'

// Covers the on-device share persistence (Marco 5): the encrypted IndexedDB round-trip that
// `storage.ts` performs. fake-indexeddb provides IndexedDB; Node's WebCrypto provides
// AES-GCM/PBKDF2 (crypto.subtle). The point is that a saved share comes back only with the
// right passphrase, never in the clear.

// A vault's id is its group key (07 x 32 for the shared test key): an export whose two differ is refused.
const GK7 = '07'.repeat(32)
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
    await saveVault('v2', data, 'right amber willow falcon')
    await expect(loadVault('v2', 'wrong-passphrase')).rejects.toThrow(/wrong passphrase|tampered/i)
  })

  it('listVaults exposes only public metadata - never the secret share', async () => {
    const list = await listVaults()
    const v = list.find((x) => x.id === 'v1')
    expect(v).toBeTruthy()
    expect(v).not.toHaveProperty('sealedShare')
    expect(Object.keys(v!).sort()).toEqual(['address', 'allSaved', 'changeReceiver', 'coordinator', 'cp', 'createdAt', 'creatorName', 'governance', 'groupKey', 'id', 'myName', 'name', 'pending', 'plainViewingKey', 'roster', 'secured', 'threshold', 'total'])
    expect(v!.name).toBe('Test vault')
    expect(v!.governance).toBe('quorum')
    expect(v!.myName).toBe('Alice')
    expect(v!.creatorName).toBe('Alice')
    // The 1..32 share bytes must not leak through the public metadata.
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(Array.from(share)))
  })

  it('lists and deletes a vault; a deleted vault cannot be loaded', async () => {
    await saveVault('v3', data, 'pale orchid thunder basket')
    expect((await listVaults()).map((x) => x.id)).toContain('v3')
    await deleteVault('v3')
    expect((await listVaults()).map((x) => x.id)).not.toContain('v3')
    await expect(loadVault('v3', 'pale orchid thunder basket')).rejects.toThrow(/no saved vault/i)
  })

  it('requires an id and a passphrase to save', async () => {
    await expect(saveVault('', data, 'pale orchid thunder basket')).rejects.toThrow(/id is required/i)
    await expect(saveVault('x', data, '')).rejects.toThrow(/passphrase is required/i)
  })
})

describe('storage - portable vault export/import (v2 opaque + v1 compat, #214/#388)', () => {
  const pass = 'carry-this-vault-across-devices'
  const shareHex = share.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')

  it('exports a v2 opaque blob that leaks no metadata or share', async () => {
    await saveVault(GK7, data, pass)
    const bundle = await exportVault(GK7, pass)
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
    expect(json).not.toContain(GK7)
  })

  it('export rejects a wrong passphrase', async () => {
    await saveVault(GK7, data, pass)
    await expect(exportVault(GK7, 'nope')).rejects.toThrow(/wrong passphrase|tampered/i)
  })

  it('v2 round-trips across a fresh device: export -> delete -> import -> load (with S)', async () => {
    const accessSecret = new Uint8Array(32).fill(5)
    await saveVault(GK7, { ...data, accessSecret }, pass)
    const bundle = await exportVault(GK7, pass)
    const roundtripped = parseVaultExport(JSON.stringify(bundle)) // survives file/paste serialization
    await deleteVault(GK7) // simulate a new device with no record
    expect((await listVaults()).map((x) => x.id)).not.toContain(GK7)

    const meta = await importVault(roundtripped, pass)
    expect(meta.id).toBe(GK7)
    expect(meta.name).toBe('Test vault')
    expect(meta.secured).toBe(true)

    const loaded = await loadVault(GK7, pass)
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
    expect(Array.from(loaded.groupKey)).toEqual(Array.from(groupKey))
    expect(loaded.roster).toEqual(['Alice', 'Bob', 'Carol'])
    expect(Array.from(loaded.accessSecret!)).toEqual(Array.from(accessSecret))
  })

  it('a vault keeps the creation protocol it was made with, through a backup and back', async () => {
    // The protocol belongs to the VAULT, not to the app reading it: an old-flow vault opened in a new
    // app must not borrow the new app's number to fetch an address the coordinator would refuse it.
    await saveVault(GK7, { ...data, cp: 2 }, pass)
    expect((await listVaults()).find((v) => v.id === GK7)!.cp).toBe(2)
    const bundle = parseVaultExport(JSON.stringify(await exportVault(GK7, pass)))
    await deleteVault(GK7)
    await importVault(bundle, pass)
    expect((await listVaults()).find((v) => v.id === GK7)!.cp).toBe(2)
    // A vault saved without one has none, never the app's.
    await saveVault(GK7, data, pass)
    expect((await listVaults()).find((v) => v.id === GK7)!.cp).toBeUndefined()
  })

  it('a backup of a vault whose creation had not finished comes back unfinished, with its quorum', async () => {
    await saveVault(GK7, { ...data, pending: true, threshold: 2, total: 3 }, pass)
    const bundle = parseVaultExport(JSON.stringify(await exportVault(GK7, pass)))
    await deleteVault(GK7)
    await importVault(bundle, pass)
    const back = (await listVaults()).find((v) => v.id === GK7)!
    expect(back.pending).toBe(true)
    expect([back.threshold, back.total]).toEqual([2, 3])
    // Finished vaults, and every backup made before, come back finished.
    await saveVault(GK7, data, pass)
    const done = parseVaultExport(JSON.stringify(await exportVault(GK7, pass)))
    await deleteVault(GK7)
    await importVault(done, pass)
    expect((await listVaults()).find((v) => v.id === GK7)!.pending).toBeUndefined()
  })

  it('a backup whose recorded quorum disagrees with its share is refused', async () => {
    const bundle = new TextEncoder().encode(JSON.stringify({ kp: 'aa', t: 2, n: 3 }))
    await saveVault(GK7, { ...data, sealedShare: bundle, threshold: 2, total: 4 }, pass)
    const exp = parseVaultExport(JSON.stringify(await exportVault(GK7, pass)))
    await deleteVault(GK7)
    await expect(importVault(exp, pass)).rejects.toThrow(/corrupt/i)
  })

  it('import rejects a wrong passphrase before writing anything', async () => {
    await saveVault(GK7, data, pass)
    const bundle = await exportVault(GK7, pass)
    await deleteVault(GK7)
    await expect(importVault(bundle, 'wrong')).rejects.toThrow(/wrong passphrase/i)
    expect((await listVaults()).map((x) => x.id)).not.toContain(GK7)
  })

  it('import refuses to overwrite an existing vault unless overwrite is set', async () => {
    await saveVault(GK7, data, pass)
    const bundle = await exportVault(GK7, pass)
    await expect(importVault(bundle, pass)).rejects.toThrow(/already exists/i)
    const meta = await importVault(bundle, pass, { overwrite: true })
    expect(meta.id).toBe(GK7)
  })

  it('carries the beneficiaries through v2 export -> import, sealed', async () => {
    const store = new Map<string, string>()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
    } as Storage
    const payees = [{ id: 'p1', name: 'Rent', address: 'u1rentpayee', memo: '', is_public: false }]
    store.set(`konclave.benef.${GK7}`, JSON.stringify(payees))
    await saveVault(GK7, data, pass)
    const bundle = await exportVault(GK7, pass)
    expect(JSON.stringify(bundle)).not.toContain('u1rentpayee') // sealed, not cleartext
    store.clear()
    await deleteVault(GK7)
    await importVault(bundle, pass)
    expect(JSON.parse(store.get(`konclave.benef.${GK7}`) ?? '[]')).toEqual(payees)
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  })

  it('refuses a v2 whose vault id is not its group key, as a v1 is', async () => {
    // The id the record was saved under is not the key it holds: the export seals both, and an
    // import would register one vault's key under another's name.
    // Both are well-formed 64-character keys, so only the equality rule can refuse it.
    const apart = 'ef'.repeat(32)
    await saveVault(apart, data, pass) // data.groupKey is 07 x 32
    const bundle = await exportVault(apart, pass)
    await deleteVault(apart)
    await expect(importVault(bundle, pass)).rejects.toThrow(/incomplete|corrupt/i)
    expect((await listVaults()).some((v) => v.id === apart)).toBe(false)
  })

  it('imports a v2 written in capitals under the app\'s lowercase id', async () => {
    const key = new Uint8Array(32).fill(0xab)
    const shouted = 'AB'.repeat(32)
    await saveVault(shouted, { ...data, groupKey: key }, pass) // the id as a hand-edited record would hold it
    const bundle = await exportVault(shouted, pass)
    await deleteVault(shouted)
    const meta = await importVault(bundle, pass)
    expect(meta.id).toBe('ab'.repeat(32))
    expect((await listVaults()).filter((v) => v.id.toLowerCase() === 'ab'.repeat(32)).map((v) => v.id)).toEqual(['ab'.repeat(32)])
    await deleteVault('ab'.repeat(32))
  })

  it('still imports a legacy v1 bundle (backward compat)', async () => {
    // Build a v1 bundle by hand: cipher = AES-GCM(passphrase) of the share, as v1 stored it.
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    // What v1 encrypted was the device bundle, the JSON the share is stored as.
    const bundleShare = new TextEncoder().encode(JSON.stringify({ kp: 'AA==', pubkeys: 'AA==', seat: 1, n: 2, t: 2 }))
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bundleShare))
    const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    // Every v1 the app wrote has its id equal to its group key (the vault IS its group key).
    const v1 = { format: 'konclave-vault-export', version: 1, exportedAt: Date.now(), vault: { id: hx(groupKey), name: 'Legacy', groupKey: hx(groupKey), address: 'u1legacy', roster: ['A', 'B'], createdAt: 111, salt: hx(salt), iv: hx(iv), cipher: hx(cipher) } }
    const parsed = parseVaultExport(JSON.stringify(v1))
    await deleteVault(hx(groupKey)) // an earlier test saved this id (the id is the shared test key)
    const meta = await importVault(parsed, pass)
    expect(meta.id).toBe(hx(groupKey))
    expect(meta.secured).toBe(false) // a v1 export has no S
    expect(Array.from((await loadVault(hx(groupKey), pass)).sealedShare)).toEqual(Array.from(bundleShare))
    // A v1 bundle keeps the address in cleartext, outside what the passphrase protects, so anyone who
    // can edit the file can change it. The screens show the recorded address over the coordinator's
    // (A9), so the import must not take it: the record starts empty, and the first answer fills it.
    expect(meta.address).toBe('')
  })

  // A genuine v1, built the way the app wrote one, for the edits below.
  async function genuineV1(extra: Record<string, unknown> = {}, id?: string) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const bundleShare = new TextEncoder().encode(JSON.stringify({ kp: 'AA==', pubkeys: 'AA==', seat: 1, n: 2, t: 2 }))
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bundleShare))
    const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    const gk = hx(crypto.getRandomValues(new Uint8Array(32)))
    return { file: { format: 'konclave-vault-export', version: 1, exportedAt: Date.now(), vault: { id: id ?? gk, name: 'Family', groupKey: gk, roster: ['A', 'B'], createdAt: 1, salt: hx(salt), iv: hx(iv), cipher: hx(cipher), ...extra } }, gk, iv: hx(iv), cipher: hx(cipher) }
  }

  it('refuses a v1 whose vault id is not its group key', async () => {
    // Edited in the clear: the seat would restore under another vault's id, whose address Add funds
    // shows, while the fingerprint (from the group key) stayed the member's own (#610 closing check).
    const { file } = await genuineV1({}, 'cd'.repeat(32))
    await expect(importVault(parseVaultExport(JSON.stringify(file)), pass)).rejects.toThrow(/incomplete|corrupt/i)
  })

  it('refuses a v1 whose id and group key agree but are not a 64-character key, with the same sentence', async () => {
    const odd = 'a'.repeat(63)
    const { file } = await genuineV1({ groupKey: odd }, odd)
    await expect(importVault(parseVaultExport(JSON.stringify(file)), pass)).rejects.toThrow(/incomplete|corrupt/i)
    const wrong = 'zz'.repeat(32)
    const g = await genuineV1({ groupKey: wrong }, wrong)
    await expect(importVault(parseVaultExport(JSON.stringify(g.file)), pass)).rejects.toThrow(/incomplete|corrupt/i)
  })

  it('stores a v1 id written in capitals as the app writes it, so it is not a second vault', async () => {
    const g = await genuineV1()
    const shouted = { ...g.file, vault: { ...g.file.vault, id: g.gk.toUpperCase() } }
    const meta = await importVault(parseVaultExport(JSON.stringify(shouted)), pass)
    expect(meta.id).toBe(g.gk)
  })

  it('does not import a v1\'s payee book, which that format keeps in the clear', async () => {
    const { file, gk } = await genuineV1({ beneficiaries: [{ label: 'Alice', address: 'u1editedbysomeone' }] })
    const g = globalThis as unknown as { localStorage?: Storage }
    const mem = new Map<string, string>()
    g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), clear: () => mem.clear(), key: () => null, length: 0 } as Storage
    try {
      await importVault(parseVaultExport(JSON.stringify(file)), pass)
      expect([...mem.entries()].filter(([k]) => k.includes(gk))).toEqual([])
    } finally {
      delete g.localStorage
    }
  })

  it('takes no read secret from a v1 unless it is one: thirty-two bytes', async () => {
    // A v1 kept the secret's envelope in the clear too; pointed at the share's own ciphertext, it
    // opened, and the share became "S": the vault showed as Private while its books stayed open.
    const g = await genuineV1()
    const edited = { ...g.file, vault: { ...g.file.vault, secretIv: g.iv, secretCipher: g.cipher } }
    const meta = await importVault(parseVaultExport(JSON.stringify(edited)), pass)
    expect(meta.secured).toBe(false)
  })

  it('refuses a current backup re-wrapped as v1 under an id of the editor\'s choosing', async () => {
    // v1 keeps the vault id and group key in cleartext. Anyone who can edit a member's backup file,
    // without the passphrase, could copy a v2 export's sealed payload into a v1 envelope and write
    // another vault's id beside it; the passphrase opens it, and the restored seat would answer as
    // that vault, whose address Add funds would then show (#610 review, A9). What a v1 sealed was a
    // share, so anything else is refused.
    await saveVault('rewrap', data, pass)
    const v2 = await exportVault('rewrap', pass)
    const v1 = { format: 'konclave-vault-export', version: 1, exportedAt: Date.now(), vault: { id: 'bb'.repeat(32), name: 'Family', groupKey: 'bb'.repeat(32), roster: ['A', 'B'], createdAt: 1, salt: v2.salt, iv: v2.iv, cipher: v2.cipher, kdfIters: v2.kdfIters } }
    await expect(importVault(parseVaultExport(JSON.stringify(v1)), pass)).rejects.toThrow(/incomplete|corrupt/i)
    expect((await listVaults()).some((v) => v.id === 'bb'.repeat(32))).toBe(false)
  })

  it('reads a backup\'s address and change receiver as text or as nothing', async () => {
    // The same reading as the money gate and the deposit screen (addressText, A9): a value that is
    // not text restores as no address, which the coordinator's first answer then fills.
    await saveVault(GK7, { ...data, address: 123 as unknown as string }, pass)
    expect(await recordChangeReceiver(GK7, 'u1change')).toBe(true)
    const bundle = await exportVault(GK7, pass)
    await deleteVault(GK7)
    const meta = await importVault(bundle, pass)
    expect(meta.address).toBe('')
    expect((await listVaults()).find((v) => v.id === GK7)?.changeReceiver).toBe('u1change')
  })

  it('imports a backup whose change receiver is not text as a record with none', async () => {
    // Built by hand: the app never writes one, but the payload is whatever its maker sealed. The
    // reading is the same as every other (addressText), so it restores with no receiver rather than
    // with a value the gate would then have to refuse.
    await saveVault(GK7, data, pass)
    const made = await exportVault(GK7, pass)
    const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    const bytesOf = (h: string) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: bytesOf(made.salt), iterations: made.kdfIters!, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const plain = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesOf(made.iv) }, key, bytesOf(made.cipher)))) as Record<string, unknown>
    plain.changeReceiver = 123
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(plain))))
    const edited = { ...made, iv: hexOf(iv), cipher: hexOf(cipher) }
    await deleteVault(GK7)
    await importVault(edited, pass)
    const rec = (await listVaults()).find((v) => v.id === GK7)
    expect(rec, 'the vault was restored').toBeDefined()
    expect(rec?.changeReceiver).toBeUndefined()
  })

  it('records no change receiver that is not text, and says so instead of throwing', async () => {
    await saveVault(GK7, data, pass)
    await expect(recordChangeReceiver(GK7, 123)).resolves.toBe(false)
    await expect(recordChangeReceiver(GK7, '  ')).resolves.toBe(false)
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
    await saveVault('sec1', { ...data, accessSecret }, 'plain walnut ember quiet')
    const loaded = await loadVault('sec1', 'plain walnut ember quiet')
    expect(loaded.accessSecret).toBeDefined()
    expect(Array.from(loaded.accessSecret!)).toEqual(Array.from(accessSecret))
    // The share is unaffected.
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
  })

  it('a vault saved without an access secret loads with accessSecret undefined (pre-#388 compat)', async () => {
    await saveVault('sec2', data, 'plain walnut ember quiet') // no accessSecret
    const loaded = await loadVault('sec2', 'plain walnut ember quiet')
    expect(loaded.accessSecret).toBeUndefined()
  })

  it('listVaults reports whether a vault is secured (has S) - never the secret itself', async () => {
    await saveVault('secured1', { ...data, accessSecret }, 'plain walnut ember quiet')
    await saveVault('open1', data, 'plain walnut ember quiet') // no accessSecret -> legacy/open vault
    const list = await listVaults()
    expect(list.find((v) => v.id === 'secured1')?.secured).toBe(true)
    expect(list.find((v) => v.id === 'open1')?.secured).toBe(false)
  })

  it('never leaks the access secret bytes into public metadata', async () => {
    await saveVault('sec3', { ...data, accessSecret }, 'plain walnut ember quiet')
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
    await saveVault('forget-1', data, 'river stone maple lantern')
    expect((await listVaults()).some((v) => v.id === 'forget-1')).toBe(true)
    expect(await forgetVault('forget-1')).toBe(true)
    expect((await listVaults()).some((v) => v.id === 'forget-1')).toBe(false)
  })

  it('takes the sealed share with it - this device can no longer open the vault at all', async () => {
    // The whole point of the control: after it, this device cannot sign for the vault. If the
    // record survived, the share survived with it.
    await saveVault('forget-2', data, 'river stone maple lantern')
    await forgetVault('forget-2')
    await expect(loadVault('forget-2', 'river stone maple lantern')).rejects.toThrow()
  })

  it('reports FALSE when the delete did not take, instead of claiming success', async () => {
    // This is why it returns a boolean rather than void. `deleteVault` no-ops when storage is
    // unavailable and ignores the delete request's own result, so a caller that assumed success
    // would tell the member their share is off the device while it is still sitting there.
    // Here the store's delete is made into a no-op: the transaction still completes cleanly, and
    // only re-reading catches it.
    await saveVault('forget-3', data, 'river stone maple lantern')
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

// #435: the PBKDF2 count used to be a module constant that nothing recorded, so raising it - the
// obvious, correct security improvement, invited by a comment reading "OWASP 2023 floor" - would
// have made every stored vault and every existing backup unopenable at once. The parameter now
// travels with the ciphertext. These pin the property that makes the future bump safe.
describe('the KDF parameter travels with the ciphertext (#435)', () => {
  /** Read a record straight out of IndexedDB, past the public API. */
  async function raw(id: string): Promise<Record<string, unknown>> {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('konclave', 1)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const g = req.result.transaction('vaults', 'readonly').objectStore('vaults').get(id)
        g.onsuccess = () => resolve(g.result as Record<string, unknown>)
        g.onerror = () => reject(g.error)
      }
    })
  }

  it('a saved record records what it was sealed with', async () => {
    // Phase two (raising the count) has to change this number too, which is the point: the bump
    // becomes a deliberate edit with a test in front of it, not a one-character change to a
    // constant whose blast radius is invisible from the line itself.
    await saveVault('kdf-1', data, 'river stone maple lantern')
    expect(await raw('kdf-1').then((r) => r.kdfIters)).toBe(600_000)
  })

  it('an export carries it too, so a backup survives a future bump', async () => {
    await saveVault('kdf-2', data, 'river stone maple lantern')
    const blob = await exportVault('kdf-2', 'river stone maple lantern')
    expect(blob.kdfIters).toBe(600_000)
  })

  it('THE POINT: a record sealed at a DIFFERENT count still opens, because the count is stored', async () => {
    // The whole migration in one test. A record is sealed here at a count that is not the module's,
    // exactly as one written by a future build would be, and `loadVault` opens it by reading the
    // number off the record instead of assuming one. Without the stored parameter this throws
    // "wrong passphrase" at a perfectly correct passphrase - which is what the one-line bump would
    // have done to every vault on every device.
    const ITERS = 310_000
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('river stone maple lantern'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt.slice().buffer, iterations: ITERS, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    )
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.slice().buffer }, key, share.slice().buffer))

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('konclave', 1)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const tx = req.result.transaction('vaults', 'readwrite')
        tx.objectStore('vaults').put({
          id: 'kdf-future', name: 'Future', groupKey: hexOf(groupKey), address: 'u1x',
          roster: ['A'], createdAt: Date.now(), salt, iv, cipher, kdfIters: ITERS,
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
    })

    const loaded = await loadVault('kdf-future', 'river stone maple lantern')
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
  })

  it('a record with NO stored count still opens: that is what every existing vault looks like', async () => {
    // The other half, and the one that would break the 8 live vaults if it were wrong. Records
    // written before this change carry no `kdfIters`, and absent must mean the legacy 210,000 -
    // never "use whatever the constant is today".
    // Sealed AT the legacy count, not at today's. This used to call `saveVault` and strip the
    // field, which only worked while the constant HAPPENED to equal the legacy value - so the test
    // was passing by coincidence, and raising the count in #479 is what exposed it. A pre-#435
    // record is one whose ciphertext was made at 210,000; building it any other way tests nothing.
    const LEGACY = 210_000
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('river stone maple lantern'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: LEGACY, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, share))
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('konclave', 1)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const store = req.result.transaction('vaults', 'readwrite').objectStore('vaults')
        const g = store.get('kdf-legacy')
        g.onsuccess = () => {
          const rec = {
            id: 'kdf-legacy', name: 'Legacy', groupKey: hexOf(groupKey), address: 'u1x',
            roster: ['A'], createdAt: Date.now(), salt, iv, cipher,
          } as Record<string, unknown> // and NO kdfIters: exactly a pre-#435 record
          const put = store.put(rec)
          put.onsuccess = () => resolve()
          put.onerror = () => reject(put.error)
        }
        g.onerror = () => reject(g.error)
      }
    })
    const loaded = await loadVault('kdf-legacy', 'river stone maple lantern')
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
  })
})

// A record sealed at the legacy count is re-sealed at the current one on the first successful open.
describe('a legacy-count record is upgraded on unlock', () => {
  async function seedLegacy(id: string, withUfvk: boolean) {
    const LEGACY = 210_000
    const secret = new Uint8Array(32).fill(9)
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('pass'), 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: LEGACY, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const secretIv = crypto.getRandomValues(new Uint8Array(12))
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, share))
    const secretCipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: secretIv }, key, secret))
    const rec: Record<string, unknown> = {
      id, name: 'Legacy', groupKey: hexOf(groupKey), address: 'u1x', roster: ['A'], createdAt: 42,
      salt, iv, cipher, secretIv, secretCipher, ...(withUfvk ? { ufvk: 'uview1clear' } : {}),
    } // no kdfIters
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('konclave', 1)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const tx = req.result.transaction('vaults', 'readwrite')
        tx.objectStore('vaults').put(rec)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
    })
    return { salt, secret }
  }
  async function rawRec(id: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('konclave', 1)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const g = req.result.transaction('vaults', 'readonly').objectStore('vaults').get(id)
        g.onsuccess = () => resolve(g.result)
        g.onerror = () => reject(g.error)
      }
    })
  }

  it('re-seals share, S and viewing key at the current count with a fresh salt', async () => {
    const { salt, secret } = await seedLegacy('up-1', true)
    const first = await loadVault('up-1', 'pass')
    expect(first.ufvk).toBe('uview1clear')
    const r = await rawRec('up-1')
    expect(r.kdfIters).toBe(600_000)
    expect(hexOf(r.salt as Uint8Array)).not.toBe(hexOf(salt))
    expect(r.ufvk).toBeUndefined()
    expect(r.createdAt).toBe(42)
    const again = await loadVault('up-1', 'pass')
    expect(Array.from(again.sealedShare)).toEqual(Array.from(share))
    expect(Array.from(again.accessSecret!)).toEqual(Array.from(secret))
    expect(again.ufvk).toBe('uview1clear')
  })

  /** Run `during` between the upgrade opening the record and writing it: its first encryption. */
  function inTheUpgradeGap(during: () => Promise<unknown>) {
    const real = crypto.subtle.encrypt.bind(crypto.subtle)
    return vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      await during()
      return real(...args)
    })
  }

  it('a passphrase change during the upgrade is not undone', async () => {
    await seedLegacy('up-gap', false)
    const moved = 'carry this vault elsewhere now'
    const spy = inTheUpgradeGap(() => changePassphrase('up-gap', 'pass', moved))
    await loadVault('up-gap', 'pass')
    spy.mockRestore()
    expect(Array.from((await loadVault('up-gap', moved)).sealedShare)).toEqual(Array.from(share))
    await expect(loadVault('up-gap', 'pass')).rejects.toThrow()
  })

  it('a salt changed by anything during the upgrade leaves that record alone', async () => {
    await seedLegacy('up-salt', false)
    const other = new Uint8Array(16).fill(7)
    const spy = inTheUpgradeGap(async () => {
      const rec = await rawRec('up-salt')
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('konclave', 1)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction('vaults', 'readwrite')
          tx.objectStore('vaults').put({ ...rec, salt: other })
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      })
    })
    await loadVault('up-salt', 'pass')
    spy.mockRestore()
    const after = await rawRec('up-salt')
    expect(hexOf(after.salt as Uint8Array)).toBe(hexOf(other))
    expect(after.kdfIters).toBeUndefined()
  })

  it('a rename during the upgrade is kept', async () => {
    await seedLegacy('up-name', false)
    const spy = inTheUpgradeGap(() => updateVaultMeta('up-name', { name: 'Renamed' }))
    await loadVault('up-name', 'pass')
    spy.mockRestore()
    const after = await rawRec('up-name')
    expect(after.name).toBe('Renamed')
    expect(after.kdfIters).toBe(600_000)
  })

  it('a viewing-key field that did not open is not re-sealed away', async () => {
    await seedLegacy('up-lost', false)
    const rec = await rawRec('up-lost')
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('konclave', 1)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const tx = req.result.transaction('vaults', 'readwrite')
        tx.objectStore('vaults').put({ ...rec, ufvkIv: new Uint8Array(12), ufvkCipher: new Uint8Array(40) })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await loadVault('up-lost', 'pass')
    error.mockRestore()
    const after = await rawRec('up-lost')
    expect(after.ufvkCipher).toEqual(new Uint8Array(40))
    expect(after.kdfIters).toBeUndefined()
  })

  it('a failed upgrade leaves the old record and the unlock still succeeds', async () => {
    const { salt } = await seedLegacy('up-2', false)
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValue(new Error('boom'))
    try {
      const loaded = await loadVault('up-2', 'pass')
      expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
    } finally {
      spy.mockRestore()
    }
    const r = await rawRec('up-2')
    expect(r.kdfIters).toBeUndefined()
    expect(hexOf(r.salt as Uint8Array)).toBe(hexOf(salt))
    expect(Array.from((await loadVault('up-2', 'pass')).sealedShare)).toEqual(Array.from(share))
    expect((await rawRec('up-2')).kdfIters).toBe(600_000) // retried on the next unlock
  })

  it('a current-count record is not touched', async () => {
    await saveVault('up-3', data, 'river stone maple lantern')
    const before = await rawRec('up-3')
    await loadVault('up-3', 'river stone maple lantern')
    const after = await rawRec('up-3')
    expect(hexOf(after.salt as Uint8Array)).toBe(hexOf(before.salt as Uint8Array))
  })
})

/** Hex, local to the test so it does not depend on storage's private helper. */
function hexOf(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

// #214/#434: a share export could not rebuild a vault, because the viewing key exists only on the
// helper's volume. `t` members could hold real spend authority over money none of them could SEE.
// The export now carries the UFVK when the device has it, so the file is the vault, not the seat.
describe('the export carries the viewing key, so it can rebuild the vault (#214)', () => {
  it('round-trips the UFVK through export and import', async () => {
    const UFVK = 'uview1testviewingkey'
    await saveVault(GK7, data, 'river stone maple lantern')
    const blob = await exportVault(GK7, 'river stone maple lantern', UFVK)
    await importVault(blob, 'river stone maple lantern', { overwrite: true })
    expect((await loadVault(GK7, 'river stone maple lantern')).ufvk).toBe(UFVK)
  })

  it('the UFVK is INSIDE the encrypted blob, never in the envelope', async () => {
    // It is the whole transaction history, amounts and memos included. A leaked export file must
    // reveal nothing without the passphrase - which is the entire point of the v2 format.
    const UFVK = 'uview1testviewingkey'
    await saveVault(GK7, data, 'river stone maple lantern')
    const blob = await exportVault(GK7, 'river stone maple lantern', UFVK)
    expect(JSON.stringify(blob)).not.toContain(UFVK)
  })

  it('an export made without it still works: the vault is exportable before it is protected', async () => {
    // An open (pre-#388) vault cannot fetch its own UFVK - the helper refuses by design. The export
    // must still be possible, just incomplete, rather than failing outright.
    await saveVault(GK7, data, 'river stone maple lantern')
    const blob = await exportVault(GK7, 'river stone maple lantern')
    await importVault(blob, 'river stone maple lantern', { overwrite: true })
    const back = await loadVault(GK7, 'river stone maple lantern')
    expect(back.ufvk).toBeUndefined()
    expect(Array.from(back.sealedShare)).toEqual(Array.from(share))
  })
})

describe('changePassphrase', () => {
  // The one credential in the product with no way to rotate (#470). It is local, per device, and
  // three lines - which is exactly why the careless version is the likely one.
  const id = 'rotate-me'

  it('the new passphrase opens the vault and the old one no longer does', async () => {
    await saveVault(id, data, 'older river stone maple')
    await changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor')
    const back = await loadVault(id, 'newer cedar lantern harbor')
    expect(Array.from(back.sealedShare)).toEqual(Array.from(share))
    await expect(loadVault(id, 'older river stone maple')).rejects.toThrow()
  })

  // THE TRAP. `saveVault` writes `createdAt: Date.now()` and does not persist `ufvk`, so the
  // obvious load-then-save would reset the creation date and silently DELETE the viewing key that
  // #447/#458 put on this device - leaving `t` members with spend authority over money none of them
  // can see. Asserted rather than left to a comment asking someone to remember.
  it('keeps the viewing key and the creation date', async () => {
    const withKey = GK7
    await saveVault(withKey, { ...data, accessSecret: new Uint8Array(32).fill(3) }, 'older river stone maple')
    const before = await loadVault(withKey, 'older river stone maple')
    // The UFVK reaches a record through import, so that is how it gets here.
    const bundle = await exportVault(withKey, 'older river stone maple', 'u1viewingkeyplaceholder', 3_470_000)
    await importVault(bundle, 'older river stone maple', { overwrite: true })
    const seeded = await loadVault(withKey, 'older river stone maple')
    expect(seeded.ufvk, 'precondition: the record carries a viewing key').toBeTruthy()

    await changePassphrase(withKey, 'older river stone maple', 'newer cedar lantern harbor')
    const after = await loadVault(withKey, 'newer cedar lantern harbor')
    expect(after.ufvk, 'the viewing key must survive a passphrase change').toBe(seeded.ufvk)
    // Same trap, second field (#480). The careless re-seal drops whatever `saveVault` does not
    // persist, and the scan floor is exactly that kind of field: losing it is silent until the day
    // someone restores and finds an empty vault.
    expect(after.birthday, 'and so must the scan floor').toBe(seeded.birthday)
    expect(after.createdAt, 'the creation date is not "now"').toBe(seeded.createdAt)
    expect(before.createdAt).toBeTruthy()
  })

  // The third field of the same trap (#281), and the one the list above missed. Losing it does not
  // make the device refuse: the next screen that reads the vault finds the slot empty and pins
  // whatever the helper answers THEN. So a rotation quietly turned a write-once pin back into
  // "trust the helper's latest answer", which is the hole the pin exists to close. Hence the second
  // half: after a rotation the slot must still refuse a new value.
  it('keeps the pinned change receiver, and keeps it write-once', async () => {
    const pinned = 'rotate-change'
    const OURS = 'aa'.repeat(43)
    const ATTACKER = 'bb'.repeat(43)
    await saveVault(pinned, data, 'older river stone maple')
    expect(await recordChangeReceiver(pinned, OURS), 'precondition: the pin is captured').toBe(true)

    await changePassphrase(pinned, 'older river stone maple', 'newer cedar lantern harbor')
    expect((await loadVault(pinned, 'newer cedar lantern harbor')).changeReceiver, 'the pin must survive a passphrase change')
      .toBe(OURS)
    expect(await recordChangeReceiver(pinned, ATTACKER), 'a rotation must not reopen the slot').toBe(false)
    expect((await listVaults()).find((v) => v.id === pinned)?.changeReceiver).toBe(OURS)
  })

  it('carries the access secret S across', async () => {
    const withS = 'rotate-s'
    const S = new Uint8Array(32).fill(9)
    await saveVault(withS, { ...data, accessSecret: S }, 'older river stone maple')
    await changePassphrase(withS, 'older river stone maple', 'newer cedar lantern harbor')
    const after = await loadVault(withS, 'newer cedar lantern harbor')
    expect(after.accessSecret && Array.from(after.accessSecret)).toEqual(Array.from(S))
  })

  it('refuses a wrong current passphrase and leaves the record alone', async () => {
    const keep = 'rotate-refuse'
    await saveVault(keep, data, 'older river stone maple')
    await expect(changePassphrase(keep, 'not-it', 'newer cedar lantern harbor')).rejects.toThrow()
    // Still openable with the original: a failed rotation must not be a lost share.
    const back = await loadVault(keep, 'older river stone maple')
    expect(Array.from(back.sealedShare)).toEqual(Array.from(share))
  })

  it('refuses an empty new passphrase', async () => {
    const keep = 'rotate-empty'
    await saveVault(keep, data, 'older river stone maple')
    await expect(changePassphrase(keep, 'older river stone maple', '')).rejects.toThrow()
    await expect(loadVault(keep, 'older river stone maple')).resolves.toBeTruthy()
  })
})

describe('the KDF parameters', () => {
  // #479. OWASP's PBKDF2 guidance is PER HASH: 600k for HMAC-SHA256, ~210k for SHA-512. The code
  // derives with SHA-256 and used 210k - the SHA-512 number paired with the SHA-256 hash, so it was
  // short by roughly 3x. Asserted here rather than left in a comment, because the two values look
  // interchangeable and the wrong pairing is invisible at the call site.
  it('uses the count OWASP gives for the hash actually in use', async () => {
    const { PBKDF2_ITERS_FOR_TESTS } = await import('./storage')
    expect(PBKDF2_ITERS_FOR_TESTS, 'SHA-256 wants 600k; 210k is the SHA-512 number').toBe(600_000)
  })

  // The property that makes raising it safe at all, and the whole point of #443: the count travels
  // WITH the ciphertext, so everything already sealed keeps opening at its own. Without this,
  // raising the number would lock every vault on every device and every backup in a drawer (#435).
  it('opens a vault sealed at the OLD count after the new one is in force', async () => {
    const id = 'kdf-migration'
    await saveVault(id, data, 'river stone maple lantern')
    const back = await loadVault(id, 'river stone maple lantern')
    expect(Array.from(back.sealedShare)).toEqual(Array.from(share))

    // And an export written before `kdfIters` existed at all falls back to the legacy count rather
    // than the current one - a v1 bundle in someone's backup must still import.
    const bundle = await exportVault(id, 'river stone maple lantern')
    const legacy = { ...bundle } as Record<string, unknown>
    delete legacy.kdfIters
    expect(() => parseVaultExport(JSON.stringify(legacy)), 'a bundle with no count still parses').not.toThrow()
  })
})

describe('the export carries the scan floor (#480)', () => {
  // #434 was entirely about this number: without it a rebuilt wallet starts scanning at NOW and
  // buries every note the vault already holds, with no rescan to undo it. The fix recorded it on
  // the helper's `registration.json` (#434), then backfilled it on re-registration (#444), then
  // moved that to boot because re-registration mostly never runs (#445).
  //
  // Nobody checked whether the EXPORT carried it. `grep -c birthday storage.ts` was 0, so a member
  // restoring from their own backup rebuilt a vault that could not see its own money - the exact
  // failure, in the second place. One rule, two homes, one of them updated: the shape of the week.
  const withKey = GK7

  it('a restore gets the scan floor, not just the viewing key', async () => {
    await saveVault(withKey, data, 'river stone maple lantern')
    const bundle = await exportVault(withKey, 'river stone maple lantern', 'uview1example', 3_459_814)
    await importVault(bundle, 'river stone maple lantern', { overwrite: true })
    const back = await loadVault(withKey, 'river stone maple lantern')
    expect(back.ufvk, 'the viewing key survives').toBe('uview1example')
    expect(back.birthday, 'and the height it must scan from').toBe(3_459_814)
  })

  it('an export from a device that never learned it says so, rather than inventing one', async () => {
    // A device that could not reach the helper has no birthday to record. Absent must stay absent:
    // a fabricated height is worse than none, because a TOO-HIGH one silently skips real notes
    // while looking like a successful restore.
    const noKey = GK7
    await saveVault(noKey, data, 'river stone maple lantern')
    const bundle = await exportVault(noKey, 'river stone maple lantern')
    await importVault(bundle, 'river stone maple lantern', { overwrite: true })
    expect((await loadVault(noKey, 'river stone maple lantern')).birthday).toBeUndefined()
  })
})

// #599: the record kept the share and `S` sealed and the viewing key beside them in the clear, so
// anyone who could read the browser profile read the vault's whole history without the passphrase.
// These read the record straight out of IndexedDB: going through `loadVault` would pass either way.
describe('the viewing key is sealed at rest (#599)', () => {
  const UFVK = 'uview1testviewingkey'
  const id = GK7

  async function db(): Promise<IDBDatabase> {
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('konclave', 1)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => resolve(req.result)
    })
  }
  async function rawRecord(): Promise<Record<string, unknown>> {
    const g = (await db()).transaction('vaults', 'readonly').objectStore('vaults').get(id)
    return await new Promise((resolve, reject) => {
      g.onsuccess = () => resolve(g.result as Record<string, unknown>)
      g.onerror = () => reject(g.error)
    })
  }
  async function putRaw(rec: Record<string, unknown>): Promise<void> {
    const tx = (await db()).transaction('vaults', 'readwrite')
    tx.objectStore('vaults').put(rec)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
  /** Everything in the record as text, bytes included, so the key is found under any field name. */
  function holdsClearKey(rec: Record<string, unknown>): boolean {
    const text = JSON.stringify(rec, (_k, v) =>
      v instanceof Uint8Array ? new TextDecoder().decode(v) : v)
    return text.includes(UFVK)
  }
  async function imported(pass = 'river stone maple lantern'): Promise<void> {
    await saveVault(id, { ...data, accessSecret: new Uint8Array(32).fill(3) }, pass)
    await importVault(await exportVault(id, pass, UFVK, 3_470_000), pass, { overwrite: true })
  }
  /** The record a build before this fix wrote on import: same envelope, the key in the clear. */
  async function writtenBeforeTheFix(pass = 'river stone maple lantern'): Promise<void> {
    await saveVault(id, { ...data, accessSecret: new Uint8Array(32).fill(3) }, pass)
    await putRaw({ ...(await rawRecord()), ufvk: UFVK, birthday: 3_470_000, changeReceiver: 'u1change' })
  }

  it('an import writes no plain viewing key, and the passphrase opens it', async () => {
    await imported()
    const rec = await rawRecord()
    expect('ufvk' in rec, 'the plain field is not written at all').toBe(false)
    expect(holdsClearKey(rec)).toBe(false)
    expect((await loadVault(id, 'river stone maple lantern')).ufvk).toBe(UFVK)
    await expect(loadVault(id, 'wrong')).rejects.toThrow(/wrong passphrase|tampered/i)
  })

  it('a record from before the fix is rewritten sealed on the next unlock, and nothing else moves', async () => {
    await writtenBeforeTheFix()
    const before = await rawRecord()
    expect(holdsClearKey(before), 'precondition: the old record holds the key in the clear').toBe(true)

    const loaded = await loadVault(id, 'river stone maple lantern')
    expect(loaded.ufvk).toBe(UFVK)

    const after = await rawRecord()
    expect('ufvk' in after, 'the plain field is gone').toBe(false)
    expect(holdsClearKey(after)).toBe(false)
    expect(after.birthday).toBe(3_470_000)
    expect(after.changeReceiver).toBe('u1change')
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.cipher, 'the share envelope is not re-sealed').toEqual(before.cipher)

    const again = await loadVault(id, 'river stone maple lantern')
    expect(again.ufvk).toBe(UFVK)
    expect(Array.from(again.sealedShare)).toEqual(Array.from(share))
    expect(Array.from(again.accessSecret!)).toEqual(Array.from(new Uint8Array(32).fill(3)))
  })

  it('a wrong passphrase migrates nothing', async () => {
    await writtenBeforeTheFix()
    await expect(loadVault(id, 'wrong')).rejects.toThrow()
    expect((await rawRecord()).ufvk).toBe(UFVK)
  })

  it('a passphrase change re-seals it: the old envelope would not open under the new key', async () => {
    await imported('older river stone maple')
    await changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor')
    expect(holdsClearKey(await rawRecord())).toBe(false)
    expect((await loadVault(id, 'newer cedar lantern harbor')).ufvk).toBe(UFVK)
    await expect(loadVault(id, 'older river stone maple')).rejects.toThrow()
  })

  it('a passphrase change on a record from before the fix leaves no plain field either', async () => {
    await writtenBeforeTheFix('older river stone maple')
    await changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor')
    const rec = await rawRecord()
    expect('ufvk' in rec).toBe(false)
    expect(holdsClearKey(rec)).toBe(false)
    expect((await loadVault(id, 'newer cedar lantern harbor')).ufvk).toBe(UFVK)
  })

  /** Run `during` in the gap between the migration reading the record and writing it: the seal is
   *  the first encryption an unlock of an old record makes. `Promise.all` never reaches this gap. */
  function inTheMigrationGap(during: () => Promise<unknown>) {
    const real = crypto.subtle.encrypt.bind(crypto.subtle)
    return vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      await during()
      return real(...args)
    })
  }

  it('a passphrase change landing during the migration is not undone', async () => {
    await writtenBeforeTheFix('older river stone maple')
    const spy = inTheMigrationGap(() => changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor'))
    await loadVault(id, 'older river stone maple')
    spy.mockRestore()
    const back = await loadVault(id, 'newer cedar lantern harbor')
    expect(Array.from(back.sealedShare)).toEqual(Array.from(share))
    expect(back.ufvk).toBe(UFVK)
    await expect(loadVault(id, 'older river stone maple')).rejects.toThrow()
  })

  it('a record re-sealed by an older build during the migration keeps its plain field for the next unlock', async () => {
    // An old tab rotates without touching `ufvk`, so only the salt shows the key in hand is stale.
    await writtenBeforeTheFix()
    const spy = inTheMigrationGap(async () => putRaw({ ...(await rawRecord()), salt: new Uint8Array(16).fill(9) }))
    await loadVault(id, 'river stone maple lantern')
    spy.mockRestore()
    const rec = await rawRecord()
    expect(rec.ufvk).toBe(UFVK)
    expect(rec.ufvkCipher, 'nothing sealed under a key that is no longer the record\'s').toBeUndefined()
  })

  it('a rename landing during the migration is kept', async () => {
    await writtenBeforeTheFix()
    const spy = inTheMigrationGap(() => updateVaultMeta(id, { name: 'Renamed' }))
    await loadVault(id, 'river stone maple lantern')
    spy.mockRestore()
    const rec = await rawRecord()
    expect(rec.name).toBe('Renamed')
    expect('ufvk' in rec).toBe(false)
  })

  it('a change landing during a passphrase change is kept, and a vault removed meanwhile is an error', async () => {
    await imported('older river stone maple')
    const rename = inTheMigrationGap(() => updateVaultMeta(id, { name: 'Renamed' }))
    await changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor')
    rename.mockRestore()
    expect((await rawRecord()).name).toBe('Renamed')

    const removal = inTheMigrationGap(() => deleteVault(id))
    await expect(changePassphrase(id, 'newer cedar lantern harbor', 'third meadow copper violin')).rejects.toThrow(/no saved vault/i)
    removal.mockRestore()
  })

  it('a passphrase change writes in the transaction it reads the record in', async () => {
    await imported('older river stone maple')
    const open = vi.spyOn(IDBDatabase.prototype, 'transaction')
    await changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor')
    expect(open, 'the unlock that proves the passphrase, then one read-and-write').toHaveBeenCalledTimes(2)
    open.mockRestore()
  })

  it('a migration that fails costs the unlock nothing and leaves the record for the next one', async () => {
    await writtenBeforeTheFix()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('no'))
    expect((await loadVault(id, 'river stone maple lantern')).ufvk).toBe(UFVK)
    spy.mockRestore()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
    expect((await rawRecord()).ufvk).toBe(UFVK)
    await loadVault(id, 'river stone maple lantern')
    expect('ufvk' in (await rawRecord())).toBe(false)
  })

  it('a passphrase change removes the plain field even when the migration before it failed', async () => {
    await writtenBeforeTheFix('older river stone maple')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('no'))
    await changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor')
    spy.mockRestore()
    error.mockRestore()
    const rec = await rawRecord()
    expect('ufvk' in rec).toBe(false)
    expect((await loadVault(id, 'newer cedar lantern harbor')).ufvk).toBe(UFVK)
  })

  it('the viewing-key field cannot be pointed at another envelope of the record', async () => {
    await imported()
    const rec = await rawRecord()
    await putRaw({ ...rec, ufvkIv: rec.secretIv, ufvkCipher: rec.secretCipher })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await loadVault(id, 'river stone maple lantern')).ufvk).toBeUndefined()
    error.mockRestore()
  })

  it('the writes that patch a record read and write in ONE transaction', async () => {
    // A write built from an earlier read puts that read back: it would undo a passphrase change that
    // landed in between, and restore a plain field the migration had removed.
    await writtenBeforeTheFix()
    const open = vi.spyOn(IDBDatabase.prototype, 'transaction')
    await updateVaultMeta(id, { name: 'Renamed' })
    expect(open).toHaveBeenCalledTimes(1)
    open.mockClear()
    await putRaw({ ...(await rawRecord()), changeReceiver: undefined })
    open.mockClear()
    expect(await recordChangeReceiver(id, 'u1pinned')).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    open.mockRestore()
    const rec = await rawRecord()
    expect(rec.name).toBe('Renamed')
    expect(rec.changeReceiver).toBe('u1pinned')
  })

  it('neither viewing-key failure logs the full vault id, only its first 8 characters', async () => {
    // A vault's id is its group key. The console is read by extensions and copied into bug reports,
    // so a failure names the vault by prefix, as the rest of the app does.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The sealed key does not open.
    await imported()
    const rec = await rawRecord()
    const damaged = (rec.ufvkCipher as Uint8Array).slice()
    damaged[0]! ^= 0xff
    await putRaw({ ...rec, ufvkCipher: damaged })
    await loadVault(id, 'river stone maple lantern')
    // The migration of a plain key cannot seal it.
    await writtenBeforeTheFix()
    const seal = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('no'))
    await loadVault(id, 'river stone maple lantern')
    seal.mockRestore()
    const logged = JSON.stringify(error.mock.calls)
    error.mockRestore()
    expect(logged).toContain('did not open')
    expect(logged).toContain('could not seal')
    expect(logged).toContain(id.slice(0, 8))
    expect(logged).not.toContain(id)
  })

  it('a passphrase change refuses rather than erase a sealed viewing key that did not open', async () => {
    await imported('older river stone maple')
    const rec = await rawRecord()
    const damaged = (rec.ufvkCipher as Uint8Array).slice()
    damaged[0]! ^= 0xff
    await putRaw({ ...rec, ufvkCipher: damaged })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor').then(() => 'done', (e: { code: string }) => e.code)).toBe('sealed-field-unreadable')
    error.mockRestore()
    const after = await rawRecord()
    expect(after.ufvkCipher, 'the field is still there').toEqual(damaged)
    expect(after.salt, 'and the old passphrase still opens the record').toEqual(rec.salt)
    await expect(loadVault(id, 'older river stone maple')).resolves.toBeTruthy()
  })

  it('a passphrase change refuses rather than drop S when only half of it is there', async () => {
    await imported('older river stone maple')
    const rec = await rawRecord()
    await putRaw({ ...rec, secretIv: undefined })
    expect(await changePassphrase(id, 'older river stone maple', 'newer cedar lantern harbor').then(() => 'done', (e: { code: string }) => e.code)).toBe('sealed-field-unreadable')
    expect((await rawRecord()).secretCipher).toEqual(rec.secretCipher)
  })

  it('an export from a sealed record still carries it, with no fetch to supply it', async () => {
    await imported()
    const blob = parseVaultExport(JSON.stringify(await exportVault(id, 'river stone maple lantern')))
    await deleteVault(id)
    await importVault(blob, 'river stone maple lantern')
    expect((await loadVault(id, 'river stone maple lantern')).ufvk).toBe(UFVK)
  })

  it('a damaged viewing-key field does not lock the member out of the share', async () => {
    // The share already proved the passphrase, so calling this a wrong passphrase would be false,
    // and the viewing key can be fetched again while the share cannot.
    await imported()
    const rec = await rawRecord()
    const damaged = (rec.ufvkCipher as Uint8Array).slice()
    damaged[0]! ^= 0xff
    await putRaw({ ...rec, ufvkCipher: damaged })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const back = await loadVault(id, 'river stone maple lantern')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
    expect(back.ufvk).toBeUndefined()
    expect(Array.from(back.sealedShare)).toEqual(Array.from(share))
  })
})
