// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// S2 of the device-storage work: the recent addresses and the payroll draft of a PROTECTED vault.
// Envelopes are made and opened by hand with WebCrypto, never with the function under test.
vi.hoisted(() => { vi.stubEnv('VITE_HELPER_BASE', 'https://helper.test') })
vi.setConfig({ testTimeout: 60_000 })

import { saveVault, loadVault, deleteVault, type VaultData } from './storage'
import { setSelectedVault } from './api'
import { setUnlockedShare, clearUnlockedShare } from './session'
import { recentPayees, pushRecentPayee } from './recent-payees'
import { readPayrollDraft, savePayrollDraft, clearPayrollDraft } from './payroll-draft'
import { RecipientCombobox } from './RecipientCombobox'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'

const GK = 'c3'.repeat(32)
const PASS = 'a long passphrase for tests'
const S = new Uint8Array(32).fill(0x5a)
const A1 = 'u1' + 'a'.repeat(76)
const A2 = 'u1' + 'b'.repeat(76)
const base = (accessSecret?: Uint8Array): VaultData => ({
  name: 'v', governance: 'quorum', myName: 'Alice', creatorName: 'Alice',
  groupKey: new Uint8Array(32).fill(0xc3), address: 'u1vault', roster: ['Alice', 'Bob'], sealedShare: new Uint8Array(32).fill(1), accessSecret,
})
async function handKey(s: Uint8Array) {
  const b = await crypto.subtle.importKey('raw', s as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('konclave-local-v1') }, b, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
const unb = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
async function handOpen(name: string, raw: string): Promise<string> {
  const e = JSON.parse(raw) as { v: number; iv: string; ct: string }
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb(e.iv), additionalData: new TextEncoder().encode(`konclave-local-v1|${GK}|${name}`) }, await handKey(S), unb(e.ct)))
}
const rk = `konclave.recentPayees.${GK}`
const dk = `konclave.folha.rascunho.${GK}`
const qk = `konclave.unreadable.recent.${GK}`
const everything = () => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n')
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 25)) }
const DRAFT = { competencia: 'March secret period', description: 'bonus round', copiedFrom: null, rows: [{ label: 'Ana', address: A1, value: '0.4242', memo: 'secret memo' }] }
async function protectedVault() { await saveVault(GK, base(S), PASS); setSelectedVault(GK) }
async function unlock() { setUnlockedShare(GK, await loadVault(GK, PASS)) }

beforeEach(async () => { clearUnlockedShare(GK); localStorage.clear(); await deleteVault(GK).catch(() => undefined) })
afterEach(() => cleanup())

describe('recent addresses of a protected vault', () => {
  it('no address reaches any storage value; they read back after the unlock, sealed', async () => {
    await protectedVault(); await unlock()
    await pushRecentPayee(A1); await pushRecentPayee(A2)
    const all = everything()
    expect(all).not.toContain('aaaaaaaa'); expect(all).not.toContain('bbbbbbbb')
    expect(JSON.parse(await handOpen('recent', localStorage.getItem(rk)!))).toEqual([A2, A1])
    expect(await recentPayees()).toEqual([A2, A1])
  })

  it('existing plain recents are sealed on unlock, to the same bytes', async () => {
    await protectedVault()
    const plain = JSON.stringify([A1, A2])
    localStorage.setItem(rk, plain)
    await unlock()
    await until(() => localStorage.getItem(rk) !== plain)
    expect(await handOpen('recent', localStorage.getItem(rk)!)).toBe(plain)
  })

  it('a plain value that is not a list is set aside, never lost', async () => {
    await protectedVault()
    localStorage.setItem(rk, 'not a list')
    await unlock()
    await until(() => localStorage.getItem(rk) === null)
    expect(localStorage.getItem(qk)).toBe('not a list')
  })

  it('locked: nothing is offered, nothing is written, and what is stored is untouched', async () => {
    await protectedVault()
    const sealed = JSON.stringify({ v: 1, iv: btoa('x'.repeat(12)), ct: btoa('y'.repeat(40)) })
    localStorage.setItem(rk, sealed)
    expect(await recentPayees()).toEqual([])
    await pushRecentPayee(A1)
    expect(localStorage.getItem(rk)).toBe(sealed)
  })

  it('an open vault keeps its bytes: a plain list of at most four, newest first', async () => {
    await saveVault(GK, base(), PASS); setSelectedVault(GK)
    for (const a of ['u1' + '1'.repeat(76), 'u1' + '2'.repeat(76), 'u1' + '3'.repeat(76), 'u1' + '4'.repeat(76), 'u1' + '5'.repeat(76)]) await pushRecentPayee(a)
    expect(localStorage.getItem(rk)).toBe(JSON.stringify(['u1' + '5'.repeat(76), 'u1' + '4'.repeat(76), 'u1' + '3'.repeat(76), 'u1' + '2'.repeat(76)]))
    expect((await recentPayees())[0]).toBe('u1' + '5'.repeat(76))
  })

  it('a web vault with no record here is neither read nor written', async () => {
    setSelectedVault('d4'.repeat(32))
    await pushRecentPayee(A1)
    expect(await recentPayees()).toEqual([])
    expect(Object.keys(localStorage).filter((k) => k.includes('recentPayees'))).toEqual([])
  })

  it('the combobox offers the recent payees once they are read (an async read, not a memo)', async () => {
    await saveVault(GK, base(), PASS); setSelectedVault(GK)
    localStorage.setItem('konclave.locale', 'en')
    localStorage.setItem(rk, JSON.stringify([A1]))
    const benefs = [{ id: 'b1', name: 'Ana Recent', address: A1, memo: '', is_public: false }, { id: 'b2', name: 'Bia Saved', address: A2, memo: '', is_public: false }]
    render(<I18nProvider><RecipientCombobox benefs={benefs} address="" name={null} onChange={() => {}} /></I18nProvider>)
    fireEvent.focus(screen.getByRole('combobox'))
    await waitFor(() => expect(screen.getByText(en['rec.recents']!)).toBeTruthy())
  })
})

describe('the payroll draft of a protected vault lives in memory only', () => {
  it('writes nothing to storage, reads back while unlocked, and is gone after clear and after lock', async () => {
    await protectedVault(); await unlock()
    await savePayrollDraft(GK, DRAFT)
    expect(everything()).not.toContain('secret'); expect(everything()).not.toContain('0.4242'); expect(everything()).not.toContain('aaaaaaaa')
    expect(Object.keys(localStorage).filter((k) => k.includes('rascunho'))).toEqual([])
    expect(await readPayrollDraft(GK)).toEqual(DRAFT)
    clearPayrollDraft(GK)
    expect(await readPayrollDraft(GK)).toBeNull()
    await savePayrollDraft(GK, DRAFT)
    clearUnlockedShare(GK)
    expect(await readPayrollDraft(GK)).toBeNull()
  })

  it('an existing plain draft is moved into memory on unlock and removed from disk, so it is not lost once', async () => {
    await protectedVault()
    localStorage.setItem(dk, JSON.stringify(DRAFT))
    await unlock()
    await until(() => localStorage.getItem(dk) === null)
    expect(localStorage.getItem(dk)).toBeNull()
    expect(await readPayrollDraft(GK)).toEqual(DRAFT)
    expect(everything()).not.toContain('secret memo')
  })

  it('the write answers what happened: written in memory, locked when locked', async () => {
    await protectedVault()
    expect(await savePayrollDraft(GK, DRAFT)).toBe('locked')
    await unlock()
    expect(await savePayrollDraft(GK, DRAFT)).toBe('written')
    const { keptIn } = await import('./vault-local')
    expect(keptIn(GK, 'draft')).toBe('memory')
    clearUnlockedShare(GK)
    expect(keptIn(GK, 'draft')).toBe('storage')
  })

  it('a corrupt draft of an open vault, set aside, is known to the sweep and to the removal', async () => {
    await saveVault(GK, base(), PASS); setSelectedVault(GK)
    localStorage.setItem(dk, '{bad')
    expect(await readPayrollDraft(GK)).toBeNull()
    const aside = `konclave.unreadable.draft.${GK}`
    expect(localStorage.getItem(aside)).toBe('{bad')
    const { tracedVaultIds } = await import('./sweep-removed')
    expect([...tracedVaultIds([aside])]).toEqual([GK])
    const { clearVaultTraces } = await import('./remove-vault')
    clearVaultTraces(GK)
    expect(localStorage.getItem(aside)).toBeNull()
  })

  it('locked: nothing is read and nothing is written', async () => {
    await protectedVault()
    localStorage.setItem(dk, JSON.stringify(DRAFT))
    expect(await readPayrollDraft(GK)).toBeNull()
    await savePayrollDraft(GK, { ...DRAFT, description: 'typed while locked' })
    expect(localStorage.getItem(dk)).toBe(JSON.stringify(DRAFT))
  })

  it('an open vault keeps today\'s bytes: the draft as plain JSON in its own key', async () => {
    await saveVault(GK, base(), PASS); setSelectedVault(GK)
    await savePayrollDraft(GK, DRAFT)
    expect(localStorage.getItem(dk)).toBe(JSON.stringify(DRAFT))
    expect(await readPayrollDraft(GK)).toEqual(DRAFT)
    clearPayrollDraft(GK)
    expect(localStorage.getItem(dk)).toBeNull()
  })
})
