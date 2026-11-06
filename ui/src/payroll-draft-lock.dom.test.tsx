// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

/* G, the lock race. `Layout` decides the lock after its own reads and clears the vault's payroll
 * draft then; the payroll screen under the overlay had already restored that draft at mount, kept
 * it in its fields, and wrote it back to storage on the next edit. The real `Layout` and the real
 * screen here; only the network, the signer and the shell's decoration are fakes. */

const health = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getBeneficiaries = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const readBalance = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health, getVault, getBeneficiaries, getLedger, getProposals, readBalance }))
vi.mock('./VaultSigner', () => ({ VaultSignerProvider: ({ children }: { children: ReactNode }) => children, useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./screens/SigningPanel', () => ({ default: () => null }))
vi.mock('./UpdatePrompt', () => ({ VersionBadge: () => null, UpdatePrompt: () => null }))
vi.mock('./AppPrefs', () => ({ default: () => null }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: Layout } = await import('./Layout')
const { default: NewPayroll } = await import('./screens/NewPayroll')
const { setSelectedVault } = await import('./api')
const { draftKey } = await import('./payroll-draft')

const ID = 'v-locked'
const ADDR = 'u1' + 'q'.repeat(76)
const DRAFT = { competencia: 'March secret period', description: 'bonus round', copiedFrom: null,
  rows: [{ label: 'Ana', address: ADDR, value: '0.4242', memo: 'secret memo' }] }
// The bridge says the vault is locked: `needsUnlock` answers yes once `getVault` lands.
const vault = { id: ID, name: 'Caixa', threshold: 2, total: 2, members: 2, member_list: [{ name: 'Ana' }, { name: 'Bia' }], group_pubkey: ID, orchard_address: ADDR, locked: true }

const mount = () => render(
  <MemoryRouter initialEntries={['/payroll']}><I18nProvider>
    <Routes><Route element={<Layout />}><Route path="/payroll" element={<NewPayroll />} /></Route></Routes>
  </I18nProvider></MemoryRouter>,
)
const values = () => [...document.querySelectorAll('input, textarea')].map((el) => (el as HTMLInputElement).value)

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('konclave.locale', 'en')
  setSelectedVault(ID)
  localStorage.setItem(draftKey(ID), JSON.stringify(DRAFT))
  health.mockResolvedValue(true)
  getVault.mockResolvedValue(vault)
  getBeneficiaries.mockResolvedValue([])
  getLedger.mockResolvedValue([])
  getProposals.mockResolvedValue([])
  readBalance.mockResolvedValue(null)
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('a locked vault keeps no payroll draft, on screen or on disk (G)', () => {
  it('empties the fields behind the overlay, and an edit while locked writes nothing', async () => {
    mount()
    await screen.findByText(en('lock.prompt'))
    await waitFor(() => expect(localStorage.getItem(draftKey(ID))).toBeNull())
    await waitFor(() => {
      const v = values()
      for (const secret of ['March secret period', 'bonus round', '0.4242', 'secret memo']) expect(v).not.toContain(secret)
    })
    fireEvent.change(screen.getByPlaceholderText(en('payroll.competencePlaceholder')), { target: { value: 'typed while locked' } })
    await new Promise((r) => setTimeout(r, 50))
    expect(localStorage.getItem(draftKey(ID))).toBeNull()
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('typed while locked')
  })
})
