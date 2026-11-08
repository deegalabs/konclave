// The real WASM and the real store over a real creation's bundle, the same one the coordinator's own
// code reads in orchestrator/tests/creation_crossing.rs. Only the coordinator's answer is stubbed.
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 120_000 })
const h = vi.hoisted(() => ({ answer: null as { ufvk: string; birthday?: number } | null }))
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), getUfvk: async () => h.answer }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
import init, { pkpDigestHex, uaReceiver } from './wasm-pkg/konclave_wasm.js'
import { saveVault, listVaults, loadVault, importVault, exportVault, changePassphrase, updateVaultMeta, recordChangeReceiver, type VaultData } from './storage'
import { adoptVaultReceivers, checkedViewingKey, repairVaultReceivers } from './vault-receivers'
import { buildVaultBackup } from './build-backup'
import { ourReceiversFrom, mayContribute } from './approved-payment'
import { receiversFingerprint } from './format'
import { unb64 } from './net'
const dump = JSON.parse(readFileSync(new URL('../../orchestrator/tests/fixtures/creation-crossing.json', import.meta.url), 'utf8'))
const U = dump.ufvks
const GK: string = dump.groupKey
const hexb = (s: string) => Uint8Array.from(s.match(/../g)!, (b) => parseInt(b, 16))
const bundle = (i = 0) => new TextEncoder().encode(JSON.stringify({ kp: dump.seats[i].kp, pubkeys: dump.seats[i].pubkeys, seat: dump.seats[i].seat, n: 3, t: 2 }))
const data = (over: Partial<VaultData> = {}): VaultData => ({ name: 'V', governance: 'quorum', myName: 'Ana', creatorName: 'Ana', groupKey: hexb(GK), address: '', roster: ['Ana', 'Bia', 'Caio'], sealedShare: bundle(), threshold: 2, total: 3, cp: 3, ...over } as VaultData)
const rec = async () => (await listVaults()).find((v) => v.id === GK)!
const gate = async () => ourReceiversFrom(await rec(), uaReceiver)
const reset = async (over: Partial<VaultData> = {}) => { await saveVault(GK, data(over), 'pw') ; return loadVault(GK, 'pw') }
const openBackup = async (b: { json: string }) => {
  const e = JSON.parse(b.json); const salt = hexb(e.salt), iv = hexb(e.iv), c = hexb(e.cipher)
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: e.kdfIters, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, c)))
}
beforeAll(async () => { await init(readFileSync(new URL('./wasm-pkg/konclave_wasm_bg.wasm', import.meta.url))) })

describe('real wasm, real storage, stub only the answer', () => {
  it('S1 fresh verified from the key, exact vector', async () => {
    const s = await reset(); h.answer = { ufvk: U.K, birthday: 100 }
    await adoptVaultReceivers(GK, s)
    const r = await rec(); expect(r.address).toBe(U.externalK); expect(r.changeReceiver).toBe(U.internalK); expect(r.receiversState).toBe('verified')
    expect(r.viewingFingerprint).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/)
    expect((await gate())?.length).toBe(2)

  })
  it('S2 same ak, other nk: refused, stays pinned, no share', async () => {
    const s = await reset(); h.answer = { ufvk: U.K }; await adoptVaultReceivers(GK, s)
    const before = await rec(); h.answer = { ufvk: U.K2 }
    await adoptVaultReceivers(GK, s)
    const r = await rec(); expect(r.receiversState).toBe('refused'); expect(r.address).toBe(before.address); expect(r.viewingFingerprint).toBe(before.viewingFingerprint); expect(r.servedFingerprint).not.toBe(before.viewingFingerprint)
    expect(await gate()).toBeNull(); expect(mayContribute(r, undefined)).toBe(false)
    // backup under the refused key
    const b = await buildVaultBackup(GK, 'pw', 'V')
    expect(b.complete).toBe(false); expect((await openBackup(b)).ufvk).toBeUndefined()
    // an honest answer clears it
    h.answer = { ufvk: U.K }; await adoptVaultReceivers(GK, s); expect((await rec()).receiversState).toBe('verified'); expect((await rec()).servedFingerprint).toBeDefined()
  })
  it('S3 malformed and wrong kinds of key: foreign ak, sapling item, testnet, garbage', async () => {
    for (const [, k] of [['foreignAk', U.foreignAk], ['withSapling', U.withSapling], ['testnet', U.testnet], ['garbage', 'uview1x2w3'], ['empty', ' ']] as const) {
      const s = await reset(); h.answer = { ufvk: k }
      const v = await adoptVaultReceivers(GK, s)
      expect(v.state).toBe('refused'); const r = await rec(); expect(r.address).toBeFalsy(); expect(await gate()).toBeNull()
    }
  })
  it('S4 Sapling or multi receiver address on the record is refused', async () => {
    for (const a of [U.saplingUa, U.extraReceiverUa, 'zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly', 'not an address']) {
      const s = await reset({ address: a }); h.answer = { ufvk: U.K }
      const v = await adoptVaultReceivers(GK, s)
      expect(v.state).toBe('refused'); expect((await rec()).address).toBe(a); expect(await gate()).toBeNull()
    }
  })
  it('S5 repair: wrong code, wrong pass, right code; then the old key is refused', async () => {
    const s = await reset(); h.answer = { ufvk: U.K, birthday: 1 }; await adoptVaultReceivers(GK, s)
    h.answer = { ufvk: U.K2, birthday: 1 }; await adoptVaultReceivers(GK, s)
    const r = await rec()
    await repairVaultReceivers(GK, 'nope', r.servedFingerprint!)
    await repairVaultReceivers(GK, 'pw', r.viewingFingerprint!)
    expect((await rec()).receiversState).toBe('refused')
    const v = await repairVaultReceivers(GK, 'pw', r.servedFingerprint!.replace(/-/g, ' ').toLowerCase())
    expect(v.state).toBe('verified'); const after = await rec(); expect(after.address).not.toBe(r.address); expect(after.viewingFingerprint).toBe(r.servedFingerprint); expect(after.servedFingerprint).toBeUndefined()
    expect((await gate())?.length).toBe(2)
    h.answer = { ufvk: U.K }; await adoptVaultReceivers(GK, s); expect((await rec()).receiversState).toBe('refused'); expect((await rec()).address).toBe(after.address)
  })
  it('S6 restored backup with a foreign sealed key: what a withheld answer exports', async () => {
    const s = await reset({ address: '' }); h.answer = { ufvk: U.K, birthday: 5 }; await adoptVaultReceivers(GK, s)
    const exp = await exportVault(GK, 'pw', U.K2, 5)  // a file whose key does not derive the address, written by an earlier hostile answer
    await importVault(exp, 'pw', { overwrite: true })
    expect(await gate()).toBeNull()
    h.answer = null
    const b = await buildVaultBackup(GK, 'pw', 'V'); const p = await openBackup(b)
    expect(p.ufvk).not.toBe(U.K2)
    expect(b.complete).toBe(false)
    h.answer = { ufvk: U.K2 }
    const c = await buildVaultBackup(GK, 'pw', 'V'); const q = await openBackup(c)
    expect(q.ufvk).not.toBe(U.K2)
    expect(c.complete).toBe(false)
  })
  it('S7 corrupted share: bundle not json', async () => {
    const s = await reset({ sealedShare: new Uint8Array([1, 2, 3]) } as never); h.answer = { ufvk: U.K }
    await expect(adoptVaultReceivers(GK, s)).rejects.toThrow()
    expect(await checkedViewingKey(GK, s)).toBe(null)
    await updateVaultMeta(GK, { cp: undefined } as never)
    await saveVault(GK, data({ cp: undefined, sealedShare: new Uint8Array([1, 2, 3]) } as never), 'pw')
    expect((await buildVaultBackup(GK, 'pw', 'V')).complete).toBe(false) // an incomplete export beats none
  })
  it('S8 other writers: meta, change, passphrase change, import', async () => {
    const s = await reset(); h.answer = { ufvk: U.K }; await adoptVaultReceivers(GK, s); const v = await rec()
    await updateVaultMeta(GK, { address: U.saplingUa }); await recordChangeReceiver(GK, U.saplingUa)
    const a = await rec(); expect(a.address).toBe(v.address); expect(a.changeReceiver).toBe(v.changeReceiver)
    await changePassphrase(GK, 'pw', 'pw2'); expect((await rec()).receiversState).toBe('verified')
    await changePassphrase(GK, 'pw2', 'pw')
    // a verified state does not survive an overwrite by import, and a file cannot claim it
    const exp = await exportVault(GK, 'pw', U.K, 1); await importVault(exp, 'pw', { overwrite: true })
    expect((await rec()).receiversState).not.toBe('verified')
  })
  it('S9 code does not depend on spelling and fits the alphabet', async () => {
    const a = await receiversFingerprint(GK, '00'.repeat(43), '11'.repeat(43)); const b = await receiversFingerprint(GK.toUpperCase(), '00'.repeat(43), '11'.repeat(43)); expect(a).toBe(b)
  })
})

describe('the same bundle the coordinator reads', () => {
  it('the device computes the digest the coordinator verifies', () => {
    expect(pkpDigestHex(unb64(dump.seats[0].pubkeys), 2, 3)).toBe(dump.digest)
    expect(JSON.parse(dump.seats[0].cert).seat).toBe(dump.seats[0].seat)
  })
})

