// What a protocol-3 device holds as its vault's address and change receiver: only what the vault's
// own viewing key derives, against this device's own package. The derivation is tested in Rust; here
// is who writes the result and what follows from each answer.
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { codeAt } from './source-scan'

const h = vi.hoisted(() => ({
  ufvk: null as { ufvk: string; birthday?: number } | null,
  derive: vi.fn(),
  exact: vi.fn((ua: string, raw: string) => ua === `ua-of-${raw}`),
  record: vi.fn(),
  refuse: vi.fn(),
  rec: {} as Record<string, unknown>,
  load: vi.fn(),
  swap: vi.fn(),
  decode: vi.fn(),
}))
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), getUfvk: async () => h.ufvk }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./signing', async (orig) => ({ ...(await orig<typeof import('./signing')>()), decodeBundle: (...a: unknown[]) => h.decode(...a) }))
vi.mock('./device-key', async (orig) => ({ ...(await orig<typeof import('./device-key')>()), deviceCommsKey: () => ({}), devicePubHex: () => 'aa' }))
vi.mock('./wasm-pkg/konclave_wasm.js', async (orig) => ({ ...(await orig<object>()), vaultReceivers: h.derive, uaIsExactly: h.exact }))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => [h.rec],
  recordVerifiedReceivers: h.record,
  recordReceiversRefused: h.refuse,
  loadVault: h.load,
  replaceRefusedReceivers: h.swap,
}))

const { adoptVaultReceivers, checkedViewingKey, repairVaultReceivers } = await import('./vault-receivers')
const { receiversFingerprint } = await import('./format')
const srcPath = (f: string) => join(dirname(fileURLToPath(import.meta.url)), f)
function sourceFiles(dir = srcPath('.')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'wasm-pkg' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}
const DERIVED = JSON.stringify({ external: 'ee', internal: 'dd', externalUa: 'ua-of-ee', internalUa: 'ua-of-dd' })
const share = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  h.ufvk = { ufvk: 'uview' }
  h.derive.mockReturnValue(DERIVED)
  h.rec = { id: V, cp: 3 }
})

const V = 'ab'.repeat(32)

describe('adoptVaultReceivers', () => {
  it('an empty record takes what the key derives, never a served value', async () => {
    expect(await adoptVaultReceivers(V, share)).toEqual({ state: 'verified', address: 'ua-of-ee' })
    expect(h.record).toHaveBeenCalledWith(V, 'ua-of-ee', 'ua-of-dd', expect.any(String), { address: '', change: '' }, undefined)
  })
  it('a record that agrees is kept, in the spelling it has', async () => {
    h.rec = { id: V, cp: 3, address: 'ua-of-ee', changeReceiver: 'ua-of-dd' }
    expect(await adoptVaultReceivers(V, share)).toEqual({ state: 'verified', address: 'ua-of-ee' })
  })
  it('another address or change receiver on the record is refused', async () => {
    for (const rec of [{ address: 'foreign' }, { changeReceiver: 'foreign' }]) {
      h.rec = { id: V, cp: 3, ...rec }
      expect(await adoptVaultReceivers(V, share)).toEqual({ state: 'refused' })
    }
    expect(h.refuse).toHaveBeenCalledTimes(2)
    expect(h.record).not.toHaveBeenCalled()
  })
  it('a key that does not derive for this package is refused, and no answer is not', async () => {
    h.derive.mockImplementation(() => { throw new Error('NotThisVault') })
    expect(await adoptVaultReceivers(V, share)).toEqual({ state: 'refused' })
    expect(h.refuse).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    h.ufvk = null
    expect(await adoptVaultReceivers(V, share)).toEqual({ state: 'unavailable' })
    expect(h.refuse).not.toHaveBeenCalled()
    expect(h.record).not.toHaveBeenCalled()
  })
})

const DECODED = ({ keyPackage: new Uint8Array(1), pubkeys: new Uint8Array(2) })
beforeEach(() => { h.decode.mockReset(); h.decode.mockReturnValue(DECODED) })

describe('repairing a device that pinned a key the vault does not answer with', () => {
  const refused = { id: V, cp: 3, receiversState: 'refused', viewingFingerprint: 'OLD', address: 'ua-of-old' }
  const agreedCode = async () => receiversFingerprint(V, 'ee', 'dd')
  const repair = (typed: string, pass = 'right') => repairVaultReceivers(V, pass, typed)
  beforeEach(() => { h.rec = refused; h.load.mockResolvedValue({}) })

  it('the passphrase comes first, and nothing is touched without it', async () => {
    h.load.mockRejectedValueOnce(new Error('wrong passphrase'))
    expect(await repair(await agreedCode(), 'nope')).toEqual({ state: 'wrongPassphrase' })
    expect(h.swap).not.toHaveBeenCalled()
  })
  it('only the key whose code the member typed is taken, whatever the coordinator answers at that click', async () => {
    h.derive.mockReturnValue(JSON.stringify({ external: 'e2', internal: 'd2', externalUa: 'ua-e2', internalUa: 'ua-d2' }))
    expect(await repair(await agreedCode())).toEqual({ state: 'notConfirmed' })
    expect(h.swap).not.toHaveBeenCalled()
  })
  it('the record is untouched while there is no answer, or the key does not derive', async () => {
    h.ufvk = null
    expect(await repair(await agreedCode())).toEqual({ state: 'unavailable' })
    h.ufvk = { ufvk: 'uview' }
    h.derive.mockImplementation(() => { throw new Error('NotThisVault') })
    expect(await repair(await agreedCode())).toEqual({ state: 'refused' })
    expect(h.swap).not.toHaveBeenCalled()
    expect(h.refuse).not.toHaveBeenCalled()
  })
  it('the agreed key replaces the pin in one write', async () => {
    h.swap.mockResolvedValue(true)
    const code = await agreedCode()
    expect(await repair(code.toLowerCase())).toEqual({ state: 'verified', address: 'ua-of-ee' })
    expect(h.swap).toHaveBeenCalledWith(V, 'ua-of-ee', 'ua-of-dd', code)
  })
  it('a record that is not refused is not repaired, and one a later answer already fixed stays', async () => {
    h.rec = { ...refused, receiversState: 'verified' }
    expect(await repair(await agreedCode())).toEqual({ state: 'notConfirmed' })
    h.rec = refused
    h.swap.mockResolvedValue(false)
    expect(await repair(await agreedCode())).toEqual({ state: 'notConfirmed' })
  })
  it('a code written without its dashes, or with the letters people confuse, is the same code', async () => {
    h.swap.mockResolvedValue(true)
    const typed = (await agreedCode()).replace(/-/g, ' ').toLowerCase().replace(/1/g, 'l').replace(/0/g, 'o')
    expect(await repair(typed)).toEqual({ state: 'verified', address: 'ua-of-ee' })
  })
  it('the code is long enough that it cannot be ground, and covers what is pinned', async () => {
    const code = await agreedCode()
    expect(code.replace(/-/g, '')).toHaveLength(25)
    expect(await receiversFingerprint(V, 'ee', '12')).not.toBe(code)
    const group = 'ab'.repeat(32)
    expect(await receiversFingerprint(group, 'ee', 'dd')).not.toBe(await receiversFingerprint('cd'.repeat(32), 'ee', 'dd'))
    expect(await receiversFingerprint(V, 'e2', 'dd')).not.toBe(code)
  })
  it('one caller, a member\'s form in Settings, behind a control of its own', () => {
    const callers = sourceFiles().filter((f) => codeAt(f).includes('repairVaultReceivers('))
    expect(callers.map((f) => f.split('/').pop()).sort()).toEqual(['ReceiversRepair.tsx', 'vault-receivers.ts'])
    expect(codeAt(srcPath('api.ts'))).not.toContain('repairVaultReceivers')
  })
})

describe('the viewing key a backup carries', () => {
  it('is carried only when it derives what the record holds', async () => {
    h.rec = { id: V, cp: 3, address: 'ua-of-ee', changeReceiver: 'ua-of-dd' }
    expect(await checkedViewingKey(V, share)).toEqual({ ufvk: 'uview' })
    h.rec = { id: V, cp: 3, address: 'foreign', changeReceiver: 'ua-of-dd' }
    expect(await checkedViewingKey(V, share)).toBe(null)
    h.rec = { id: V, cp: 2, address: 'foreign' }
    expect(await checkedViewingKey(V, share)).toEqual({ ufvk: 'uview' })
  })
})

describe('what adoption records', () => {
  it('a mismatch records the served code beside the held one', async () => {
    h.rec = { id: V, cp: 3, address: 'foreign', changeReceiver: 'ua-of-dd' }
    expect(await adoptVaultReceivers(V, share)).toEqual({ state: 'refused' })
    expect(h.refuse).toHaveBeenCalledWith(V, await receiversFingerprint(V, 'ee', 'dd'))
  })
  it('a change receiver that differs is a mismatch too', async () => {
    h.rec = { id: V, cp: 3, address: 'ua-of-ee', changeReceiver: 'foreign' }
    expect(await adoptVaultReceivers(V, share)).toEqual({ state: 'refused' })
  })
  it('loses to a repair that landed since it read: the write says so', async () => {
    h.rec = { id: V, cp: 3, address: 'ua-of-ee', changeReceiver: 'ua-of-dd' }
    h.record.mockResolvedValueOnce(false)
    expect(await adoptVaultReceivers(V, share)).toEqual({ state: 'unavailable' })
    expect(h.record).toHaveBeenCalledWith(V, 'ua-of-ee', 'ua-of-dd', expect.any(String), { address: 'ua-of-ee', change: 'ua-of-dd' }, undefined)
  })
})

describe('the backup key, further', () => {
  it('a change receiver that differs keeps the key out', async () => {
    h.rec = { id: V, cp: 3, address: 'ua-of-ee', changeReceiver: 'foreign' }
    expect(await checkedViewingKey(V, share)).toBe(null)
  })
  it('falls back to the sealed key only if it derives the record, and a served scan floor cannot rise', async () => {
    h.rec = { id: V, cp: 3, address: 'ua-of-ee', changeReceiver: 'ua-of-dd' }
    h.ufvk = null
    expect(await checkedViewingKey(V, { ...(share as object), ufvk: 'stored', birthday: 7 } as never)).toEqual({ ufvk: 'stored', birthday: 7 })
    h.derive.mockImplementationOnce(() => { throw new Error('NotThisVault') })
    expect(await checkedViewingKey(V, { ...(share as object), ufvk: 'stored', birthday: 7 } as never)).toBe(null)
    h.ufvk = { ufvk: 'uview', birthday: 900 }
    expect(await checkedViewingKey(V, { ...(share as object), birthday: 7 } as never)).toEqual({ ufvk: 'uview', birthday: 7 })
    h.ufvk = { ufvk: 'uview' }
    expect(await checkedViewingKey(V, { ...(share as object), birthday: 7 } as never)).toEqual({ ufvk: 'uview', birthday: 7 })
  })
  it('an unreadable part on an older vault gives no key, not a throw', async () => {
    h.rec = { id: V, cp: 2 }
    h.decode.mockImplementationOnce(() => { throw new SyntaxError('x') })
    expect(await checkedViewingKey(V, share)).toBe(null)
  })
  it('an unreadable part in a repair says that, not that the coordinator is silent', async () => {
    h.rec = { id: V, cp: 3, receiversState: 'refused', address: 'a' }
    h.load.mockResolvedValue({})
    h.decode.mockImplementationOnce(() => { throw new SyntaxError('x') })
    expect(await repairVaultReceivers(V, 'pw', 'CODE')).toEqual({ state: 'unreadable' })
  })
})

