import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeAll } from 'vitest'
vi.setConfig({ testTimeout: 60_000 })
import { loadVault, saveVault } from './storage'

const share = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1))
const secret = new Uint8Array(32).fill(9)
const AAD = new TextEncoder().encode('konclave-ufvk-at-rest')
const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

async function putRaw(rec: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('konclave', 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const tx = req.result.transaction('vaults', 'readwrite')
      tx.objectStore('vaults').put(rec)
      tx.oncomplete = () => { req.result.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  })
}
async function rawRec(id: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('konclave', 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const g = req.result.transaction('vaults', 'readonly').objectStore('vaults').get(id)
      g.onsuccess = () => { req.result.close(); resolve(g.result) }
      g.onerror = () => reject(g.error)
    }
  })
}
async function seed(id: string, o: { iters?: number; storeIters?: boolean; clearUfvk?: string; sealedUfvk?: string } = {}) {
  const iters = o.iters ?? 210_000
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('pass'), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const secretIv = crypto.getRandomValues(new Uint8Array(12))
  const rec: Record<string, unknown> = {
    id, name: 'Legacy', groupKey: '07'.repeat(32), address: 'u1x', roster: ['A'], createdAt: 42, salt, iv,
    cipher: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, share)),
    secretIv,
    secretCipher: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: secretIv }, key, secret)),
    ...(o.clearUfvk ? { ufvk: o.clearUfvk } : {}),
    ...(o.storeIters ? { kdfIters: iters } : {}),
  }
  if (o.sealedUfvk) {
    const ufvkIv = crypto.getRandomValues(new Uint8Array(12))
    rec.ufvkIv = ufvkIv
    rec.ufvkCipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ufvkIv, additionalData: AAD }, key, new TextEncoder().encode(o.sealedUfvk)))
  }
  await putRaw(rec)
  return rec
}
/** The nth call to encrypt seals other bytes than it was handed: a seal that opens to the wrong content. */
function sealsOtherBytesOnCall(n: number) {
  const real = crypto.subtle.encrypt.bind(crypto.subtle)
  let count = 0
  return vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (alg, key, data) => {
    count += 1
    if (count !== n) return real(alg, key, data)
    const other = new Uint8Array(data as ArrayBuffer).slice()
    other[0]! ^= 0xff
    return real(alg, key, other)
  })
}

// Creates the object store: the raw helpers open version 1 without an upgrade handler.
beforeAll(() => saveVault('bootstrap', { name: 'b', governance: 'quorum', myName: 'A', creatorName: 'A', groupKey: new Uint8Array(32).fill(7), address: 'u1x', roster: ['A'], sealedShare: share } as never, 'bootstrap river stone maple lantern'))

describe('legacy upgrade: gaps found by mutation', () => {
  it('a record at a HIGHER count than the current one is not lowered', async () => {
    const before = await seed('k-high', { iters: 700_000, storeIters: true })
    await loadVault('k-high', 'pass')
    const after = await rawRec('k-high')
    expect(after.kdfIters).toBe(700_000)
    expect(hexOf(after.salt as Uint8Array)).toBe(hexOf(before.salt as Uint8Array))
  })

  it('when retiring the clear viewing key failed, the upgrade itself removes the plain field', async () => {
    await seed('k-clear', { clearUfvk: 'uview1clear' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('boom')) // sealUfvk in retireClearUfvk
    await loadVault('k-clear', 'pass')
    spy.mockRestore(); err.mockRestore()
    const r = await rawRec('k-clear')
    expect(r.kdfIters).toBe(600_000)
    expect(r.ufvk).toBeUndefined()
    expect((await loadVault('k-clear', 'pass')).ufvk).toBe('uview1clear')
  })

  it('when the upgrade fails, the clear viewing key is still gone (retired under the old seal)', async () => {
    await seed('k-retire', { clearUfvk: 'uview1clear' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const real = crypto.subtle.encrypt.bind(crypto.subtle)
    let n = 0
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (a, k, d) => {
      n += 1
      if (n === 2) throw new Error('boom') // 1 = retire's sealUfvk, 2 = the upgrade's share
      return real(a, k, d)
    })
    await loadVault('k-retire', 'pass')
    spy.mockRestore(); err.mockRestore()
    const r = await rawRec('k-retire')
    expect(r.kdfIters).toBeUndefined()
    expect(r.ufvk).toBeUndefined()
    expect(r.ufvkCipher).toBeDefined()
  })

  it('a failed upgrade names the vault by its first 8 characters only', async () => {
    const id = 'c'.repeat(64)
    await seed(id)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValue(new Error('boom'))
    await loadVault(id, 'pass')
    spy.mockRestore()
    const logged = JSON.stringify(err.mock.calls)
    err.mockRestore()
    expect(logged).toContain('could not re-seal')
    expect(logged).toContain(id.slice(0, 8))
    expect(logged).not.toContain(id)
  })

  // The calls during an upgrade of a record with a sealed viewing key: 1 share, 2 S, 3 viewing key.
  for (const [label, call] of [['share', 1], ['S', 2], ['viewing key', 3]] as const) {
    it(`a new seal that opens to other bytes (${label}) is not written`, async () => {
      const before = await seed(`k-bytes-${call}`, { sealedUfvk: 'uview1sealed' })
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const spy = sealsOtherBytesOnCall(call)
      const loaded = await loadVault(`k-bytes-${call}`, 'pass')
      spy.mockRestore(); err.mockRestore()
      expect(Array.from(loaded.sealedShare)).toEqual(Array.from(share))
      const r = await rawRec(`k-bytes-${call}`)
      expect(r.kdfIters).toBeUndefined()
      expect(hexOf(r.salt as Uint8Array)).toBe(hexOf(before.salt as Uint8Array))
      expect(hexOf(r.cipher as Uint8Array)).toBe(hexOf(before.cipher as Uint8Array))
      const again = await loadVault(`k-bytes-${call}`, 'pass') // the old record still opens, and now upgrades
      expect(Array.from(again.sealedShare)).toEqual(Array.from(share))
      expect(Array.from(again.accessSecret!)).toEqual(Array.from(secret))
      expect(again.ufvk).toBe('uview1sealed')
    })
  }
})
