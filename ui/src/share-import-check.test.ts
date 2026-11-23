/// <reference types="node" />
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import init, { TestVault } from './wasm-pkg/konclave_wasm.js'
import { b64, bytesToHex as hex } from './bytes'
import { importVault, kdfItersOf, loadVault, listVaults, saveVault, deleteVault, type VaultExport, type VaultData } from './storage'
import { heldAside, vaultKey } from './vault-local'
import { StorageError, storageErrorKey } from './storage-errors'
import { unlockWith, openFailKey, type UnlockDeps } from './unlock'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #965: an import checked that a backup was a device bundle and that its id was its group key, and
// never that the key package in it was the seat's share of THAT vault. A package that belongs to
// another seat, another vault, or whose signing share was edited imported without a word, and failed
// later, at signing. The check is `check_share_bundle` in konclave-wasm; this file holds the two
// doors it guards - an import (both export versions) and the one place a sealed share is opened.
vi.setConfig({ testTimeout: 60_000 })
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))

// The payee book is the second thing an import writes; the node environment has no localStorage.
const book = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => book.get(k) ?? null,
  setItem: (k: string, v: string) => { book.set(k, v) },
  removeItem: (k: string) => { book.delete(k) },
})

beforeAll(async () => {
  await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url)))
})

const PASS = 'correct horse battery staple'
const ITERS = 210_000 // an accepted count that is cheaper than today's, so a test need not pay for 600k rounds

// Offsets in a serialized key package: identifier, then the 32-byte signing share at 37..69.
const SIGNING_SHARE_AT = 40

function bundle(kp: Uint8Array, pubkeys: Uint8Array, seat: unknown, t: unknown = 2): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ kp: b64(kp), pubkeys: b64(pubkeys), seat, n: 3, t }))
}

/** A real 2-of-3 vault and the bundles a device could hold for it. */
function fixtures() {
  const v = new TestVault()
  const other = new TestVault()
  const gk = v.groupVk()
  const tampered = v.key_package(0).slice()
  tampered[SIGNING_SHARE_AT] = tampered[SIGNING_SHARE_AT]! ^ 0x01
  return {
    gk,
    honest: bundle(v.key_package(0), v.pubkeys(), 1),
    another_seat: bundle(v.key_package(1), v.pubkeys(), 1),
    another_vault: bundle(other.key_package(0), other.pubkeys(), 1),
    another_vaults_group: bundle(v.key_package(0), other.pubkeys(), 1),
    tampered_signing_share: bundle(tampered, v.pubkeys(), 1),
    // The honest package under a seat or quorum that is not a whole number in range, or is another one.
    seat_as_text: bundle(v.key_package(0), v.pubkeys(), '1'),
    seat_out_of_range: bundle(v.key_package(0), v.pubkeys(), 65537),
    quorum_fraction: bundle(v.key_package(0), v.pubkeys(), 1, 2.5),
    another_quorum: bundle(v.key_package(0), v.pubkeys(), 1, 3),
  }
}

async function aesKey(salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
}
async function seal(plain: Uint8Array) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await aesKey(salt), plain as BufferSource))
  return { salt: hex(salt), iv: hex(iv), cipher: hex(cipher) }
}

async function v2Export(share: Uint8Array, gk: Uint8Array): Promise<VaultExport> {
  const payload = {
    id: hex(gk), groupKey: hex(gk), address: '', roster: ['A', 'B', 'C'], createdAt: 1,
    share: hex(share), threshold: 2, total: 3, beneficiaries: [{ label: 'kept?' }], peopleUnreadable: 'set-aside-copy',
  }
  return { format: 'konclave-vault-export', version: 2, exportedAt: 1, kdfIters: ITERS, ...(await seal(new TextEncoder().encode(JSON.stringify(payload)))) }
}
async function v1Export(share: Uint8Array, gk: Uint8Array): Promise<VaultExport> {
  const s = await seal(share)
  return {
    format: 'konclave-vault-export', version: 1, exportedAt: 1,
    vault: { id: hex(gk), groupKey: hex(gk), address: '', roster: ['A', 'B', 'C'], createdAt: 1, kdfIters: ITERS, ...s },
  }
}

const refusal = async (p: Promise<unknown>) => {
  try { await p } catch (e) { return e }
  throw new Error('expected a refusal')
}

describe.each([['v2', v2Export], ['v1', v1Export]] as const)('importing a %s backup checks the share against its vault (#965)', (_name, build) => {
  it('an honest backup imports', async () => {
    const f = fixtures()
    const id = hex(f.gk)
    const meta = await importVault(await build(f.honest, f.gk), PASS)
    expect(meta.id).toBe(id)
    // The same probe the refusals use: here it does find the payee book, so a null there means "not written".
    if (_name === 'v2') expect(localStorage.getItem(vaultKey('benef', id))).not.toBeNull()
    // The pair of the refusals' set-aside probe: an honest v2 backup does keep its unreadable book aside.
    if (_name === 'v2') expect(heldAside(id, 'benef')).not.toBeNull()
    await deleteVault(id)
    book.clear()
  })

  for (const bad of ['another_seat', 'another_vault', 'another_vaults_group', 'tampered_signing_share', 'seat_as_text', 'seat_out_of_range', 'quorum_fraction', 'another_quorum'] as const) {
    it(`refuses ${bad.replaceAll('_', ' ')} before anything is written`, async () => {
      const f = fixtures()
      const id = hex(f.gk)
      const err = await refusal(importVault(await build(f[bad], f.gk), PASS))
      expect(err).toBeInstanceOf(StorageError)
      expect((err as StorageError).code).toBe('wrong-seat')
      expect((await listVaults()).map((v) => v.id)).not.toContain(id)
      expect(localStorage.getItem(vaultKey('benef', id))).toBeNull()
      expect(heldAside(id, 'benef')).toBeNull() // nor a set-aside copy of a book the backup could not include
    })
  }

  it('a share that is not a device bundle at all is the same refusal in both versions', async () => {
    const f = fixtures()
    const err = await refusal(importVault(await build(new Uint8Array([1, 2, 3]), f.gk), PASS))
    expect((err as StorageError).code).toBe('corrupt')
    expect(kdfItersOf(ITERS)).toBe(ITERS) // the fixture's count is accepted, so this refusal is the share's
  })

  it('says the backup does not belong to this seat, in both languages', async () => {
    const f = fixtures()
    const err = await refusal(importVault(await build(f.another_seat, f.gk), PASS))
    const key = storageErrorKey(err, 'import.errGeneric')
    expect(key).toBe('storage.err.wrongSeat')
    expect(en[key]).toMatch(/does not belong to this seat/)
    expect(ptBR[key]).toMatch(/não pertence a este assento/)
    // The same sentence shows on export and the other places a share is opened, so it claims only
    // what is true of all of them: nothing was changed.
    expect(en[key]).toMatch(/Nothing was changed/)
    expect(en[key]).not.toMatch(/import/i)
    expect(ptBR[key]).toMatch(/Nada foi alterado/)
  })
})

describe('opening a saved share checks it too (#965)', () => {
  const record = (f: ReturnType<typeof fixtures>, share: Uint8Array): VaultData => ({
    groupKey: f.gk, address: '', roster: ['A', 'B', 'C'], sealedShare: share, threshold: 2, total: 3,
  })

  it('an honest record opens', async () => {
    const f = fixtures()
    await saveVault(hex(f.gk), record(f, f.honest), PASS)
    const loaded = await loadVault(hex(f.gk), PASS)
    expect(Array.from(loaded.sealedShare)).toEqual(Array.from(f.honest))
    await deleteVault(hex(f.gk))
  })

  for (const bad of ['another_seat', 'another_vault', 'tampered_signing_share'] as const) {
    it(`a record holding ${bad.replaceAll('_', ' ')} is refused, with its own message`, async () => {
      const f = fixtures()
      await saveVault(hex(f.gk), record(f, f[bad]), PASS)
      const err = await refusal(loadVault(hex(f.gk), PASS))
      expect((err as StorageError).code).toBe('wrong-seat')
      await deleteVault(hex(f.gk))
    })
  }

  it('the unlock does not put a refused share in the session, and says why', async () => {
    const f = fixtures()
    await saveVault(hex(f.gk), record(f, f.another_seat), PASS)
    const calls: string[] = []
    const deps = {
      loadVault, setUnlockedShare: () => { calls.push('session') }, markVaultUnlocked: () => { calls.push('marked') },
      unlockVault: async () => ({ ok: true }), registerThisDevice: async () => { calls.push('registered'); return true },
      adoptVaultReceivers: async () => {},
    } as unknown as UnlockDeps
    const r = await unlockWith(deps, hex(f.gk), 'net', PASS)
    expect(r).toMatchObject({ ok: false, wrong: false, notThisSeat: true })
    expect(calls).toEqual([])
    expect(openFailKey(false, 'net', true)).toBe('vaults.openWrongSeat')
    expect(en['vaults.openWrongSeat']).toMatch(/does not belong to this seat/)
    expect(ptBR['vaults.openWrongSeat']).toMatch(/não pertence a este assento/)
    await deleteVault(hex(f.gk))
  })
})
