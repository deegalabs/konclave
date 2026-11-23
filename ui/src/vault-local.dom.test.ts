// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'

// The door every per-vault value passes through (vault-local.ts). Envelopes are made and opened by
// hand with WebCrypto: a test that builds one with the function that reads it is consistent by
// construction and proves nothing.
vi.hoisted(() => { vi.stubEnv('VITE_HELPER_BASE', 'https://helper.test') })
vi.setConfig({ testTimeout: 60_000 })

import { saveVault, loadVault, deleteVault, type VaultData } from './storage'
import { setUnlockedShare, clearUnlockedShare, setReadSecret, clearReadSecret } from './session'
import { clearVaultTraces } from './remove-vault'
import { tracedVaultIds } from './sweep-removed'

// This suite is about what a protected vault keeps on the device, with a stand-in share. The share
// check (#965) has its own real-wasm tests in share-import-check.test.ts, so here it is let through.
vi.mock('./share-check', () => ({ assertShareIsThisSeats: async () => {} }))

const ID = 'c3'.repeat(32)
const OTHER = 'd4'.repeat(32)
const PASS = 'a long passphrase for tests'
const S = new Uint8Array(32).fill(0x5a)
const NAME = 'benef'
const PLAIN = JSON.stringify([{ id: 'p1', name: 'Marisol Quintana', address: 'u1abc', memo: '', is_public: false }])
const data = (accessSecret?: Uint8Array): VaultData => ({
  name: 'v', governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey: new Uint8Array(32).fill(0xc3), address: 'u1vault', roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1), accessSecret,
})
async function handKey(s: Uint8Array) {
  const b = await crypto.subtle.importKey('raw', s as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('konclave-local-v1') }, b, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const unb = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const aadOf = (id: string, name: string) => new TextEncoder().encode(`konclave-local-v1|${id}|${name}`)
async function handOpen(id: string, name: string, raw: string, s = S): Promise<string> {
  const e = JSON.parse(raw) as { v: number; iv: string; ct: string }
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb(e.iv), additionalData: aadOf(id, name) }, await handKey(s), unb(e.ct)))
}
async function handSeal(id: string, name: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadOf(id, name) }, await handKey(S), new TextEncoder().encode(text)))
  const b = (x: Uint8Array) => btoa(String.fromCharCode(...x))
  return JSON.stringify({ v: 1, iv: b(iv), ct: b(ct) })
}
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 25)) }
const k = (id = ID) => `konclave.benef.${id}`

beforeEach(async () => {
  localStorage.clear()
  clearUnlockedShare(ID); clearReadSecret(ID)
  await deleteVault(ID).catch(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('the key and the migration follow S in the session', () => {
  it('(8) the passphrase path: setUnlockedShare seals what is in the clear, to the same bytes', async () => {
    await saveVault(ID, data(S), PASS)
    localStorage.setItem(k(), PLAIN)
    setUnlockedShare(ID, await loadVault(ID, PASS))
    await until(() => localStorage.getItem(k()) !== PLAIN)
    expect(await handOpen(ID, NAME, localStorage.getItem(k())!)).toBe(PLAIN)
    expect(localStorage.getItem(k())).not.toContain('Marisol')
  })

  it('(8) the passkey path: setReadSecret (S without the share) seals it too', async () => {
    localStorage.setItem(k(), PLAIN)
    setReadSecret(ID, S)
    await until(() => localStorage.getItem(k()) !== PLAIN)
    expect(await handOpen(ID, NAME, localStorage.getItem(k())!)).toBe(PLAIN)
  })

  it('(8) only session.ts starts it, and every way S enters goes through the setters', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const { join, relative, sep } = await import('node:path')
    const src = join(process.cwd(), 'src')
    const files: string[] = []
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n) && !/\.test\.|\.d\.ts$/.test(n)) files.push(relative(src, p).split(sep).join('/')) } }
    walk(src)
    expect(files.filter((f) => f !== 'vault-local.ts' && /\bvaultLocalUnlocked\(/.test(codeOf(f)))).toEqual(['session.ts'])
    expect(codeOf('session.ts')).toMatch(/vaultLocalUnlocked\(/)
    expect(codeOf('unlock.ts')).toMatch(/setUnlockedShare\(/)
    expect(codeOf('passkey-unlock.ts')).toMatch(/setReadSecret\(/)
    expect(codeOf('screens/NetVault.tsx')).toMatch(/setUnlockedShare\(/)
  })

  it('(9) taking S out of the session locks the vault again', async () => {
    await saveVault(ID, data(S), PASS)
    localStorage.setItem(k(), await handSeal(ID, NAME, PLAIN))
    const { readLocal } = await import('./vault-local')
    setUnlockedShare(ID, await loadVault(ID, PASS))
    expect((await readLocal(ID, NAME)).s).toBe('ok')
    clearUnlockedShare(ID)
    expect((await readLocal(ID, NAME)).s).toBe('locked')
  })
})

describe('writes', () => {
  it('(5) two tabs (two copies of the module over one storage) adding alternately lose nothing', async () => {
    const mods = [await import('./vault-local'), await (async () => { vi.resetModules(); return import('./vault-local') })()]
    expect(mods[0]).not.toBe(mods[1])
    for (const m of mods) m.vaultLocalUnlocked(ID, S)
    const adds: Promise<unknown>[] = []
    for (let i = 0; i < 12; i++) adds.push(mods[i % 2]!.updateLocal(ID, 'benef', (cur) => [...((cur as number[] | undefined) ?? []), i]))
    expect(await Promise.all(adds)).toEqual(Array(12).fill('written'))
    const got = JSON.parse(await handOpen(ID, NAME, localStorage.getItem(k())!)) as number[]
    expect([...got].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('(6) many fast writes: the last one is what persists', async () => {
    const m = await import('./vault-local')
    m.vaultLocalUnlocked(ID, S)
    const ws = Array.from({ length: 25 }, (_, i) => m.updateLocal(ID, 'benef', () => ['v', i]))
    await Promise.all(ws)
    expect(JSON.parse(await handOpen(ID, NAME, localStorage.getItem(k())!))).toEqual(['v', 24])
  })

  it('(6) a slow first write does not land after a later one', async () => {
    const m = await import('./vault-local')
    m.vaultLocalUnlocked(ID, S)
    await new Promise((r) => setTimeout(r, 100)) // let the migration pass go by
    const real = crypto.subtle.encrypt.bind(crypto.subtle)
    let first = true
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...a: Parameters<typeof real>) => {
      if (first) { first = false; await new Promise((r) => setTimeout(r, 80)) }
      return real(...a)
    })
    await Promise.all([m.updateLocal(ID, 'benef', () => ['first']), m.updateLocal(ID, 'benef', () => ['last'])])
    expect(JSON.parse(await handOpen(ID, NAME, localStorage.getItem(k())!))).toEqual(['last'])
  })

  it('(7) a write that fails leaves the clear copy, and the next unlock seals it', async () => {
    const m = await import('./vault-local')
    localStorage.setItem(k(), PLAIN)
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    m.vaultLocalUnlocked(ID, S)
    await new Promise((r) => setTimeout(r, 300))
    set.mockRestore()
    expect(localStorage.getItem(k())).toBe(PLAIN)
    m.vaultLocalUnlocked(ID, S)
    await until(() => localStorage.getItem(k()) !== PLAIN)
    expect(await handOpen(ID, NAME, localStorage.getItem(k())!)).toBe(PLAIN)
  })

  it('(7) an envelope that does not open is moved aside, read as unreadable, and never overwritten', async () => {
    const m = await import('./vault-local')
    m.vaultLocalUnlocked(ID, S)
    const bad = JSON.stringify({ v: 1, iv: btoa('x'.repeat(12)), ct: btoa('y'.repeat(40)) })
    localStorage.setItem(k(), bad)
    expect((await m.readLocal(ID, NAME)).s).toBe('unreadable')
    expect(localStorage.getItem(`konclave.unreadable.benef.${ID}`)).toBe(bad)
    expect(localStorage.getItem(k())).toBeNull()
    // a second bad value does not overwrite the first one kept aside, and stays where it is: no write over it
    const bad2 = JSON.stringify({ v: 1, iv: btoa('z'.repeat(12)), ct: btoa('q'.repeat(40)) })
    localStorage.setItem(k(), bad2)
    expect(await m.updateLocal(ID, 'benef', () => ['new'])).toBe('unreadable')
    expect(localStorage.getItem(k())).toBe(bad2)
    expect(localStorage.getItem(`konclave.unreadable.benef.${ID}`)).toBe(bad)
  })

  it('(7) an envelope of another vault (other AAD) does not open here', async () => {
    const m = await import('./vault-local')
    m.vaultLocalUnlocked(ID, S)
    localStorage.setItem(k(), await handSeal(OTHER, NAME, PLAIN))
    expect((await m.readLocal(ID, NAME)).s).toBe('unreadable')
  })
})

describe('one list of per-vault keys', () => {
  it('(12) removing a vault deletes the envelope and the quarantine; the sweep finds a vault by either', () => {
    localStorage.setItem(k(), '{"v":1}')
    localStorage.setItem(`konclave.unreadable.benef.${ID}`, 'x')
    localStorage.setItem(k(OTHER), '{"v":1}')
    expect([...tracedVaultIds([`konclave.unreadable.benef.${ID}`])]).toEqual([ID])
    clearVaultTraces(ID)
    expect(Object.keys(localStorage).filter((x) => x.includes(ID))).toEqual([])
    expect(localStorage.getItem(k(OTHER))).not.toBeNull()
  })

  it('(12) the files that touch localStorage are a list; shrinking it is what is left of #868', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const { join, relative, sep } = await import('node:path')
    const src = join(process.cwd(), 'src')
    const files: string[] = []
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n) && !/\.test\.|\.d\.ts$/.test(n)) files.push(relative(src, p).split(sep).join('/')) } }
    walk(src)
    const touching = files.filter((f) => /\b(?:localStorage|sessionStorage)\b/.test(codeOf(f))).sort()
    expect(touching).toEqual([
      'helper.ts', 'i18n/index.tsx', 'net.ts', 'prf-store.ts', 'price.ts',
      'remove-vault.ts', 'screens/Dashboard.tsx', 'seen-store.ts', 'service-url.ts', 'shown-vault.ts', 'signed-record.ts',
      'sweep-removed.ts', 'theme.ts', 'vault-local.ts', 'vault-status.ts',
    ])
    // The book is not reached around the door.
    for (const f of ['api.ts', 'storage.ts']) expect(codeOf(f), f).not.toMatch(/localStorage\.[a-zA-Z]+\([^)]*(?:benef|beneficiariesKey)/)
  })
})

describe('what is set aside, and what a seal is made of', () => {
  it('(1) while a set-aside copy exists, a read answers unreadable and a write is refused: never absent', async () => {
    const m = await import('./vault-local')
    m.vaultLocalUnlocked(ID, S)
    localStorage.setItem(k(), JSON.stringify({ v: 1, iv: btoa('x'.repeat(12)), ct: btoa('y'.repeat(40)) }))
    expect((await m.readLocal(ID, NAME)).s).toBe('unreadable')
    expect((await m.readLocal(ID, NAME)).s).toBe('unreadable')
    expect(await m.updateLocal(ID, 'benef', () => ['x'])).toBe('unreadable')
    expect((await m.readSealed(S, ID, NAME)).s).toBe('unreadable')
  })

  it('(2) any object that is not a v1 envelope is unreadable on a protected vault, and kept aside', async () => {
    const m = await import('./vault-local')
    m.vaultLocalUnlocked(ID, S)
    const v2 = JSON.stringify({ v: 2, iv: 'a', ct: 'b' })
    localStorage.setItem(k(), v2)
    expect((await m.readLocal(ID, NAME)).s).toBe('unreadable')
    expect(localStorage.getItem(`konclave.unreadable.benef.${ID}`)).toBe(v2)
    localStorage.removeItem(`konclave.unreadable.benef.${ID}`)
    const damaged = JSON.stringify({ v: 1, iv: 7, ct: 'b' })
    localStorage.setItem(k(), damaged)
    expect((await m.readLocal(ID, NAME)).s).toBe('unreadable')
  })

  it('(2) the migration does not seal an object that is not a list as if it were the book', async () => {
    const odd = JSON.stringify({ v: 2, note: 'not a list' })
    localStorage.setItem(k(), odd)
    setReadSecret(ID, S)
    await until(() => localStorage.getItem(k()) === null)
    expect(localStorage.getItem(`konclave.unreadable.benef.${ID}`)).toBe(odd)
  })

  it('(10) two writes of the same value use different IVs', async () => {
    const m = await import('./vault-local')
    m.vaultLocalUnlocked(ID, S)
    await m.updateLocal(ID, 'benef', () => ['same'])
    const a = JSON.parse(localStorage.getItem(k())!) as { iv: string; ct: string }
    await m.updateLocal(ID, 'benef', () => ['same'])
    const b = JSON.parse(localStorage.getItem(k())!) as { iv: string; ct: string }
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('(10) a clear value that is not JSON is set aside by the migration, not deleted', async () => {
    localStorage.setItem(k(), 'not json at all')
    setReadSecret(ID, S)
    await until(() => localStorage.getItem(k()) === null)
    expect(localStorage.getItem(`konclave.unreadable.benef.${ID}`)).toBe('not json at all')
  })

  it('(8) the sealed keys are named only in vault-local.ts', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const { join, relative, sep } = await import('node:path')
    const src = join(process.cwd(), 'src')
    const files: string[] = []
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(n) && !/\.test\.|\.d\.ts$/.test(n)) files.push(relative(src, p).split(sep).join('/')) } }
    walk(src)
    const named = files.filter((f) => /vaultKey\(\s*'benef'|unreadableKey\(|beneficiariesKey/.test(codeOf(f))).sort()
    expect(named).toEqual(['vault-local.ts'])
  })
})

describe('the refusal a change function can make', () => {
  it('(2) REFUSE over a valid list writes nothing and answers unreadable', async () => {
    const m = await import('./vault-local')
    m.vaultLocalUnlocked(ID, S)
    await m.updateLocal(ID, 'benef', () => ['keep'])
    const before = localStorage.getItem(k())
    expect(await m.updateLocal(ID, 'benef', () => m.REFUSE)).toBe('unreadable')
    expect(localStorage.getItem(k())).toBe(before)
  })
})

describe('order of writes', () => {
  it('two writes made in order land in order even when the first one is slower to learn the vault is open', async () => {
    const ID2 = 'e5'.repeat(32)
    await saveVault(ID2, { ...data(), groupKey: new Uint8Array(32).fill(0xe5) }, PASS) // an open vault: no key in the session, the record decides
    const storage = await import('./storage')
    const real = storage.readVaults
    let first = true
    vi.spyOn(storage, 'readVaults').mockImplementation(async () => {
      if (first) { first = false; await new Promise((r) => setTimeout(r, 80)) }
      return real()
    })
    const m = await import('./vault-local')
    const a = m.updateLocal(ID2, 'recent', () => ['first'])
    const b = m.updateLocal(ID2, 'recent', () => ['last'])
    expect(await Promise.all([a, b])).toEqual(['written', 'written'])
    expect(JSON.parse(localStorage.getItem(`konclave.recentPayees.${ID2}`)!)).toEqual(['last'])
  })
})
