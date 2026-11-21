// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The payee book of a PROTECTED vault is sealed on this device (S1 of the device-storage work). Every
// envelope here is built and opened by hand with WebCrypto, never with the function under test.
vi.hoisted(() => { vi.stubEnv('VITE_HELPER_BASE', 'https://helper.test') })
vi.setConfig({ testTimeout: 60_000 })

import { saveVault, loadVault, exportVault, importVault, deleteVault, type VaultData } from './storage'
import { addBeneficiary, getBeneficiaries, deleteBeneficiary, setSelectedVault, humanError, appendPerson, withoutPerson, getSelectedVault } from './api'
import { REFUSE } from './vault-local'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
import { setUnlockedShare, clearUnlockedShare } from './session'

const GK = 'c3'.repeat(32)
const PASS = 'a long passphrase for tests'
const S = new Uint8Array(32).fill(0x5a)
const ADDR = 'u1' + 'q'.repeat(76)
const BOOK = [
  { id: 'p1', name: 'Marisol Quintana', address: ADDR, memo: 'rent', is_public: false },
  { id: 'p2', name: 'Teodoro Vance', address: 'u1' + 'w'.repeat(76), memo: '', is_public: false },
]
const base = (over: Partial<VaultData> = {}): VaultData => ({
  name: 'v', governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey: new Uint8Array(32).fill(0xc3), address: 'u1vault', roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1), ...over,
})
const bookKey = (id = GK) => `konclave.benef.${id}`

// By hand: HKDF-SHA256(S, info "konclave-local-v1") -> AES-GCM-256, AAD "konclave-local-v1|id|name".
async function handKey(s: Uint8Array) {
  const b = await crypto.subtle.importKey('raw', s as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('konclave-local-v1') }, b, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const unb = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
async function handOpen(s: Uint8Array, id: string, name: string, raw: string): Promise<string> {
  const e = JSON.parse(raw) as { v: number; iv: string; ct: string }
  expect(e.v).toBe(1)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb(e.iv), additionalData: new TextEncoder().encode(`konclave-local-v1|${id}|${name}`) }, await handKey(s), unb(e.ct))
  return new TextDecoder().decode(pt)
}
async function handSeal(s: Uint8Array, id: string, name: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`konclave-local-v1|${id}|${name}`) }, await handKey(s), new TextEncoder().encode(text)))
  const b = (x: Uint8Array) => btoa(String.fromCharCode(...x))
  return JSON.stringify({ v: 1, iv: b(iv), ct: b(ct) })
}
const everything = () => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n')
const noClearText = () => {
  const all = everything()
  for (const w of ['Marisol', 'Teodoro', 'rent', 'qqqqqqqq', 'wwwwwwww']) expect(all, w).not.toContain(w)
}
async function protectedVault() {
  await saveVault(GK, base({ accessSecret: S }), PASS)
  setSelectedVault(GK)
}
async function unlock() { setUnlockedShare(GK, await loadVault(GK, PASS)) }
const settle = () => new Promise((r) => setTimeout(r, 50))

beforeEach(async () => {
  clearUnlockedShare(GK)
  localStorage.clear()
  await deleteVault(GK).catch(() => undefined)
})

describe('the payee book of a protected vault', () => {
  it('(1) leaves no name, address or memo in any storage value after a write', async () => {
    await protectedVault()
    await unlock()
    for (const p of BOOK) expect((await addBeneficiary(getSelectedVault(), p.name, p.address, p.memo)).ok).toBe(true)
    noClearText()
    expect(JSON.parse(await handOpen(S, GK, 'benef', localStorage.getItem(bookKey())!))).toHaveLength(2)
    const list = await getBeneficiaries(getSelectedVault())
    expect(list?.map((b) => b.name)).toEqual(['Marisol Quintana', 'Teodoro Vance'])
    // and a removal too
    expect(await deleteBeneficiary(getSelectedVault(), list![0]!.id)).toEqual({ ok: true })
    noClearText()
    expect((await getBeneficiaries(getSelectedVault()))?.map((b) => b.name)).toEqual(['Teodoro Vance'])
  })

  it('(1, import) a backup\'s book lands sealed, with NO session, and is readable after the unlock (2)', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), JSON.stringify(BOOK)) // the clear book of a not-yet-migrated vault
    const bundle = await exportVault(GK, PASS)
    await deleteVault(GK)
    localStorage.clear()
    clearUnlockedShare(GK)
    await importVault(bundle, PASS) // the session is empty here: importAndUnlock unlocks only AFTER this
    noClearText()
    expect(JSON.parse(await handOpen(S, GK, 'benef', localStorage.getItem(bookKey())!))).toEqual(BOOK)
    setSelectedVault(GK)
    await unlock()
    expect(await getBeneficiaries(getSelectedVault())).toEqual(BOOK)
  })

  it('(3) exports from a locked device (only the passphrase) and carries the book', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), await handSeal(S, GK, 'benef', JSON.stringify(BOOK)))
    const bundle = await exportVault(GK, PASS) // session empty
    await deleteVault(GK)
    localStorage.clear()
    await importVault(bundle, PASS)
    expect(JSON.parse(await handOpen(S, GK, 'benef', localStorage.getItem(bookKey())!))).toEqual(BOOK)
  })

  it('(3) a book that does not open never yields a silent empty book: the export says the people were left out', async () => {
    await protectedVault()
    const sealed = JSON.parse(await handSeal(S, GK, 'benef', JSON.stringify(BOOK))) as { ct: string }
    sealed.ct = sealed.ct.slice(0, -6) + 'AAAAAA'
    localStorage.setItem(bookKey(), JSON.stringify({ v: 1, iv: (JSON.parse(await handSeal(S, GK, 'benef', '[]')) as { iv: string }).iv, ct: sealed.ct }))
    const report: { peopleLeftOut?: boolean } = {}
    await exportVault(GK, PASS, undefined, undefined, { report })
    expect(report.peopleLeftOut).toBe(true)
    expect(localStorage.getItem(`konclave.unreadable.benef.${GK}`)).not.toBeNull() // kept aside, not lost
  })

  it('(4) an add right after the session gets S, with no waiting, keeps the old entries', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), JSON.stringify(BOOK)) // still in the clear: not migrated yet
    await unlock()
    const r = await addBeneficiary(getSelectedVault(), 'Nuria', 'u1' + 'e'.repeat(76), '') // no await between the unlock and this
    expect(r.ok).toBe(true)
    await settle()
    expect((await getBeneficiaries(getSelectedVault()))?.map((b) => b.name)).toEqual(['Marisol Quintana', 'Teodoro Vance', 'Nuria'])
    noClearText()
  })

  it('(4) and when the sealing of the old book fails (a full quota), the add still keeps it', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), JSON.stringify(BOOK))
    const real = Storage.prototype.setItem
    let failed = false
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (!failed && k === bookKey() && v.startsWith('{"v":1')) { failed = true; throw new Error('quota') }
      return real.call(this, k, v)
    })
    await unlock()
    const r = await addBeneficiary(getSelectedVault(), 'Nuria', 'u1' + 'e'.repeat(76), '')
    spy.mockRestore()
    expect(failed).toBe(true)
    expect(r.ok).toBe(true)
    expect((await getBeneficiaries(getSelectedVault()))?.map((b) => b.name)).toEqual(['Marisol Quintana', 'Teodoro Vance', 'Nuria'])
  })

  it('(9) locked: nothing is read, nothing is written, and the list is unavailable (null), not empty', async () => {
    await protectedVault()
    const sealed = await handSeal(S, GK, 'benef', JSON.stringify(BOOK))
    localStorage.setItem(bookKey(), sealed)
    expect(await getBeneficiaries(getSelectedVault())).toBeNull()
    const r = await addBeneficiary(getSelectedVault(), 'Nuria', 'u1' + 'e'.repeat(76), '')
    expect(r.ok).toBe(false)
    expect((await deleteBeneficiary(getSelectedVault(), 'p1')).ok).toBe(false)
    expect(localStorage.getItem(bookKey())).toBe(sealed)
  })

  it('(9) a web vault with no record on this device is neither read nor written', async () => {
    setSelectedVault('d4'.repeat(32))
    expect(await getBeneficiaries(getSelectedVault())).toBeNull()
    expect((await addBeneficiary(getSelectedVault(), 'Nuria', 'u1' + 'e'.repeat(76), '')).ok).toBe(false)
    expect(localStorage.getItem(bookKey('d4'.repeat(32)))).toBeNull()
  })

  it('(10) an open vault keeps today\'s bytes', async () => {
    await saveVault(GK, base(), PASS) // no S: open
    setSelectedVault(GK)
    const r = await addBeneficiary(getSelectedVault(), 'Nuria', 'u1' + 'e'.repeat(76), ' hi ')
    expect(r.ok).toBe(true)
    const b = r.ok ? r.beneficiary : null
    expect(localStorage.getItem(bookKey())).toBe(JSON.stringify([b]))
    expect(await getBeneficiaries(getSelectedVault())).toEqual([b])
    await deleteBeneficiary(getSelectedVault(), b!.id)
    expect(localStorage.getItem(bookKey())).toBe('[]')
  })

  it('(11) an older bundle reading the envelope throws and writes nothing, instead of replacing it', async () => {
    const sealed = await handSeal(S, GK, 'benef', JSON.stringify(BOOK))
    localStorage.setItem(bookKey(), sealed)
    // The reader and the writers of before this change, copied.
    const oldList = (): unknown[] => { try { return JSON.parse(localStorage.getItem(bookKey()) ?? '[]') as unknown[] } catch { return [] } }
    const oldAdd = (b: unknown) => localStorage.setItem(bookKey(), JSON.stringify([...oldList(), b]))
    const oldDelete = (id: string) => localStorage.setItem(bookKey(), JSON.stringify((oldList() as { id: string }[]).filter((b) => b.id !== id)))
    expect(() => oldAdd({ id: 'x' })).toThrow()
    expect(() => oldDelete('p1')).toThrow()
    expect(localStorage.getItem(bookKey())).toBe(sealed)
  })
})

const tamper = async (text: string) => {
  const o = JSON.parse(await handSeal(S, GK, 'benef', text)) as { v: number; iv: string; ct: string }
  return { ...o, ct: o.ct.slice(0, -6) + 'AAAAAA' }
}
// Rewrites the payload of a real export by hand (PBKDF2 + AES-GCM), to make a backup of another shape.
async function rewriteBundle(bundle: Awaited<ReturnType<typeof exportVault>>, edit: (p: Record<string, unknown>) => void) {
  const unh = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))
  const hx = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unh(bundle.salt), iterations: bundle.kdfIters!, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unh(bundle.iv) }, key, unh(bundle.cipher))
  const p = JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>
  edit(p)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unh(bundle.iv) }, key, new TextEncoder().encode(JSON.stringify(p))))
  return { ...bundle, cipher: hx(ct) }
}
const NU = 'u1' + 'e'.repeat(76)

describe('a book that cannot be read is never taken for an empty one', () => {
  it('(1) after a corrupt book is set aside, reads and adds still refuse and every export says the people were left out', async () => {
    await protectedVault()
    await unlock()
    localStorage.setItem(bookKey(), JSON.stringify(await tamper(JSON.stringify(BOOK))))
    expect(await getBeneficiaries(getSelectedVault())).toBeNull()
    expect(await getBeneficiaries(getSelectedVault())).toBeNull() // the second read used to answer []
    const r = await addBeneficiary(getSelectedVault(), 'Nuria', NU, '')
    expect(r.ok).toBe(false)
    for (let i = 0; i < 2; i++) { // every export, not only the first
      const report: { peopleLeftOut?: boolean } = {}
      await exportVault(GK, PASS, undefined, undefined, { report })
      expect(report.peopleLeftOut).toBe(true)
    }
    expect(localStorage.getItem(bookKey())).toBeNull()
    expect(localStorage.getItem(`konclave.unreadable.benef.${GK}`)).not.toBeNull()
  })

  it('(2) an object that is not a v1 envelope is not the book: an add refuses and the value is kept', async () => {
    await protectedVault()
    await unlock()
    const v2 = JSON.stringify({ ...JSON.parse(await handSeal(S, GK, 'benef', JSON.stringify(BOOK))), v: 2 })
    localStorage.setItem(bookKey(), v2)
    expect(await getBeneficiaries(getSelectedVault())).toBeNull()
    expect((await addBeneficiary(getSelectedVault(), 'Nuria', NU, '')).ok).toBe(false)
    expect([localStorage.getItem(bookKey()), localStorage.getItem(`konclave.unreadable.benef.${GK}`)]).toContain(v2)
    expect(await getBeneficiaries(getSelectedVault())).toBeNull()
  })

  it('(2) the add and the remove refuse a value that is not a list instead of turning it into one', () => {
    expect(appendPerson({ v: 2 }, BOOK[0]!)).toBe(REFUSE)
    expect(withoutPerson('nope', 'p1')).toBe(REFUSE)
    expect(appendPerson(undefined, BOOK[0]!)).toEqual([BOOK[0]])
    expect(withoutPerson(BOOK, 'p1')).toEqual([BOOK[1]])
  })

  it('(3) changing the coordination mode at runtime does not make a locked protected vault write in the clear', async () => {
    await protectedVault()
    localStorage.setItem('konclave.coord.mode', 'custom') // no url: the helper reads as "none" from here on
    const r = await addBeneficiary(getSelectedVault(), 'Nuria', NU, '')
    expect(r.ok).toBe(false)
    expect(localStorage.getItem(bookKey())).toBeNull()
    localStorage.removeItem('konclave.coord.mode')
  })
})

describe('what the member is told', () => {
  it('(4) each failure has its own code, and humanError says it in both languages, never the raw code', async () => {
    setSelectedVault('')
    localStorage.removeItem('konclave.selectedVault')
    expect(await addBeneficiary(getSelectedVault(), 'Nuria', NU, '')).toMatchObject({ error: 'vault changed' }) // the screen showed no vault: nothing is written
    await protectedVault()
    expect(await addBeneficiary(getSelectedVault(), 'Nuria', NU, '')).toMatchObject({ error: 'storage locked' })
    await unlock()
    localStorage.setItem(bookKey(), JSON.stringify(await tamper('[]')))
    expect(await addBeneficiary(getSelectedVault(), 'Nuria', NU, '')).toMatchObject({ error: 'storage unreadable' })
    localStorage.removeItem(bookKey()); localStorage.removeItem(`konclave.unreadable.benef.${GK}`)
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const r = await addBeneficiary(getSelectedVault(), 'Nuria', NU, '')
    spy.mockRestore()
    expect(r).toMatchObject({ error: 'storage failed' })
    for (const [dict, tag] of [[en, 'en'], [ptBR, 'pt']] as const) {
      const t = (k: string) => (dict as Record<string, string>)[k] ?? k
      const texts = ['storage locked', 'storage unreadable', 'storage failed'].map((c) => humanError(t, c))
      for (const [i, c] of ['storage locked', 'storage unreadable', 'storage failed'].entries()) {
        expect(texts[i], `${tag} ${c}`).not.toBe(c)
        expect(texts[i], `${tag} ${c}`).not.toMatch(/^error\./)
      }
      expect(new Set(texts).size).toBe(3)
    }
  })

  it('(5) an import that could not save the book says so (an unreadable one in the way, or a full quota)', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), JSON.stringify(BOOK))
    const bundle = await exportVault(GK, PASS)
    await deleteVault(GK); localStorage.clear()
    expect((await importVault(bundle, PASS)).peopleSaved).not.toBe(false)
    await deleteVault(GK)
    localStorage.setItem(bookKey(), JSON.stringify(await tamper('[]')))
    expect((await importVault(bundle, PASS)).peopleSaved).toBe(false)
    await deleteVault(GK); localStorage.clear()
    const real = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === bookKey()) throw new Error('quota')
      return real.call(this, k, v)
    })
    const meta = await importVault(bundle, PASS)
    spy.mockRestore()
    expect(meta.peopleSaved).toBe(false)
  })

  it('(5) the screen that imports shows the notice', async () => {
    const { codeOf } = await import('./source-scan')
    expect(codeOf('screens/Vaults.tsx')).toMatch(/peopleSaved === false/)
    expect(en['toast.peopleNotSaved']).toBeTruthy()
    expect(ptBR['toast.peopleNotSaved']).toBeTruthy()
  })

  it('(6) a backup made by an older tab, carrying the sealed envelope as its book, still brings the book', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), JSON.stringify(BOOK))
    const bundle = await exportVault(GK, PASS)
    const envelope = JSON.parse(await handSeal(S, GK, 'benef', JSON.stringify(BOOK))) as unknown
    const old = await rewriteBundle(bundle, (p) => { p.beneficiaries = envelope })
    await deleteVault(GK); localStorage.clear()
    expect((await importVault(old, PASS)).peopleSaved).not.toBe(false)
    expect(JSON.parse(await handOpen(S, GK, 'benef', localStorage.getItem(bookKey())!))).toEqual(BOOK)
  })

  it('(6) an envelope that does not open under the backup\'s S is reported, not dropped silently', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), JSON.stringify(BOOK))
    const bundle = await exportVault(GK, PASS)
    const old = await rewriteBundle(bundle, (p) => { p.beneficiaries = { v: 1, iv: btoa('x'.repeat(12)), ct: btoa('y'.repeat(40)) } })
    await deleteVault(GK); localStorage.clear()
    expect((await importVault(old, PASS)).peopleSaved).toBe(false)
  })
})

describe('a book that is set aside does not block the backup of the seat', () => {
  const asideKey = () => `konclave.unreadable.benef.${GK}`
  async function quarantined() {
    await protectedVault()
    await unlock()
    const bad = JSON.stringify(await tamper(JSON.stringify(BOOK)))
    localStorage.setItem(bookKey(), bad)
    expect(await getBeneficiaries(getSelectedVault())).toBeNull() // set aside by this read
    expect(localStorage.getItem(asideKey())).toBe(bad)
    return bad
  }

  it('(1) the export succeeds without the book, says so, and carries the set-aside copy as opaque data', async () => {
    const bad = await quarantined()
    const report: { peopleLeftOut?: boolean } = {}
    const bundle = await exportVault(GK, PASS, undefined, undefined, { report })
    expect(report.peopleLeftOut).toBe(true)
    let payload: Record<string, unknown> = {}
    await rewriteBundle(bundle, (p) => { payload = p })
    expect(payload.beneficiaries ?? []).toEqual([])
    expect(payload.peopleUnreadable).toBe(bad)
    expect(JSON.stringify(bundle)).not.toContain('Marisol')
  })

  it('(1) a healthy book reports nothing left out', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), JSON.stringify(BOOK))
    const report: { peopleLeftOut?: boolean } = {}
    const bundle = await exportVault(GK, PASS, undefined, undefined, { report })
    expect(report.peopleLeftOut).toBeUndefined()
    let payload: Record<string, unknown> = {}
    await rewriteBundle(bundle, (p) => { payload = p })
    expect(payload.peopleUnreadable).toBeUndefined()
  })

  it('(1) importing that backup restores the book when the set-aside copy opens under the backup\'s S', async () => {
    await protectedVault()
    localStorage.setItem(bookKey(), JSON.stringify(BOOK))
    const bundle = await exportVault(GK, PASS)
    const copy = await handSeal(S, GK, 'benef', JSON.stringify(BOOK))
    const b2 = await rewriteBundle(bundle, (p) => { p.beneficiaries = []; p.peopleUnreadable = copy })
    await deleteVault(GK); localStorage.clear()
    expect((await importVault(b2, PASS)).peopleSaved).not.toBe(false)
    expect(JSON.parse(await handOpen(S, GK, 'benef', localStorage.getItem(bookKey())!))).toEqual(BOOK)
  })

  it('(1) when the copy does not open, the import says so and keeps the copy aside on this device', async () => {
    await protectedVault()
    const bundle = await exportVault(GK, PASS)
    const junk = JSON.stringify(await tamper('[]'))
    const b2 = await rewriteBundle(bundle, (p) => { p.peopleUnreadable = junk })
    await deleteVault(GK); localStorage.clear()
    expect((await importVault(b2, PASS)).peopleSaved).toBe(false)
    expect(localStorage.getItem(asideKey())).toBe(junk)
    expect(localStorage.getItem(bookKey())).toBeNull()
  })

  it('(1) the screens say the backup was made WITHOUT the people list, not "nothing was imported"', async () => {
    const { codeOf } = await import('./source-scan')
    for (const f of ['screens/Settings.tsx', 'screens/Vaults.tsx']) expect(codeOf(f), f).toMatch(/incompleteNotices\(/)
    expect(codeOf('build-backup.ts')).toMatch(/'export\.peopleLeftOut'/)
    for (const d of [en, ptBR] as Record<string, string>[]) {
      expect(d['export.peopleLeftOut']).toBeTruthy()
      expect(d['export.peopleLeftOut']).not.toBe(d['storage.err.corrupt'])
    }
    expect(en['export.peopleLeftOut']).toMatch(/without the saved people/i)
  })

  it('(3) the import notice promises nothing the app refuses', () => {
    expect(en['toast.peopleNotSaved']).not.toMatch(/add them again/i)
    expect(ptBR['toast.peopleNotSaved']).not.toMatch(/adicione/i)
  })

  it('(2) with two copies set aside, the backup carries the NEWEST (the one still in place)', async () => {
    await protectedVault()
    await unlock()
    const older = JSON.stringify(await tamper('[1]'))
    localStorage.setItem(bookKey(), older)
    expect(await getBeneficiaries(getSelectedVault())).toBeNull() // older is set aside
    const newer = JSON.stringify({ v: 2, note: 'a later bad value' })
    localStorage.setItem(bookKey(), newer)
    expect(await getBeneficiaries(getSelectedVault())).toBeNull() // aside is taken, so the newer one stays in place
    expect(localStorage.getItem(asideKey())).toBe(older)
    let payload: Record<string, unknown> = {}
    await rewriteBundle(await exportVault(GK, PASS), (p) => { payload = p })
    expect(payload.peopleUnreadable).toBe(newer)
  })

  it('(3) importing a copy that does not open never overwrites one already set aside on this device', async () => {
    await protectedVault()
    const bundle = await exportVault(GK, PASS)
    const b2 = await rewriteBundle(bundle, (p) => { p.peopleUnreadable = JSON.stringify(tamperSync()) })
    await deleteVault(GK); localStorage.clear()
    localStorage.setItem(asideKey(), 'older copy, kept')
    expect((await importVault(b2, PASS)).peopleSaved).toBe(false)
    expect(localStorage.getItem(asideKey())).toBe('older copy, kept')
  })
})
function tamperSync() { return { v: 1, iv: btoa('x'.repeat(12)), ct: btoa('y'.repeat(40)) } }
