// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// A locked vault is not a failed read. Approvals read the proposals at mount without asking
// `needsUnlock`, so behind the unlock overlay the 401 became "Could not read the proposals"; the
// ledger drew an empty book the same way. The lock state here is REAL: a protected vault saved in
// the real store (fake-indexeddb), the real session that holds S or not, and the real rule. Only the
// network is a fake, and the test reads whether it was asked.
const GK = 'cd'.repeat(32)
const vault = { id: GK, name: 'Treasury', threshold: 2, total: 2, address: 'u1test', member_list: [{ name: 'Ana', pubkey: 'aa'.repeat(32) }, { name: 'Bia', pubkey: 'bb'.repeat(32) }] }
const getVault = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
const readTransactions = vi.hoisted(() => vi.fn())
const health = vi.hoisted(() => vi.fn())
const getProposalDetail = vi.hoisted(() => vi.fn())
const getBalance = vi.hoisted(() => vi.fn())
const vaultCeremonies = vi.hoisted(() => vi.fn())
// The web, where every vault is: the app starts with a coordinator configured, the lock is the
// device's, and the vault is the one selected.
localStorage.setItem('konclave.coord.mode', 'custom')
localStorage.setItem('konclave.coord.url', 'https://coordinator.invalid')
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getVault, getProposals, getLedger, readTransactions, health, getProposalDetail, getBalance }))
// The signer is not what this reads; the proposal screen only asks it for `open`.
vi.mock('./VaultSigner', () => ({ useVaultSigner: () => ({ open: () => {} }) }))
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), vaultCeremonies }))

const { saveVault, deleteVault } = await import('./storage')
const { setSelectedVault } = await import('./api')
const { setReadSecret, clearReadSecret } = await import('./session')
const { recordRead } = await import('./read-failure')
const { IS_NET } = await import('./api')
const { default: Proposals } = await import('./screens/Proposals')
const { default: Ledger } = await import('./screens/Ledger')
const { default: Members } = await import('./screens/Members')
const { default: Receive } = await import('./screens/Receive')
const { default: ProposalScreen } = await import('./screens/Proposal')
const { default: Ceremonies } = await import('./screens/Ceremonies')

const S = new Uint8Array(32).fill(9)
const save = (secret: boolean) => saveVault(GK, {
  name: 'Treasury', governance: 'quorum', myName: 'Ana', creatorName: 'Ana',
  groupKey: new Uint8Array(32).fill(0xcd), address: 'u1test', roster: ['Ana', 'Bia'],
  sealedShare: new Uint8Array(32).fill(1), ...(secret ? { accessSecret: S } : {}),
}, 'correct horse')

// Layout's part, and only that: the overlay context. `unlock()` does what the overlay's passphrase
// does to the app's state - S lands in the session and the nonce moves.
let unlock: () => void = () => {}
function Shell() {
  const [unlockNonce, setNonce] = useState(0)
  unlock = () => { setReadSecret(GK, S); setNonce((n) => n + 1) }
  return <Outlet context={{ locked: false, unlockNonce, live: true }} />
}
const mount = (el: ReactElement) => render(
  <MemoryRouter initialEntries={[{ pathname: '/', state: { id: 'p1' } }]}><I18nProvider><ToastProvider><Routes><Route element={<Shell />}><Route path="/" element={el} /></Route></Routes></ToastProvider></I18nProvider></MemoryRouter>,
)
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)) })

const screens: [string, () => ReactElement, () => ReturnType<typeof vi.fn>][] = [
  ['Approvals (Proposals)', () => <Proposals embedded />, () => getProposals],
  ['Ledger', () => <Ledger />, () => getLedger],
  ['Signers (Members)', () => <Members />, () => health],
  ['Add funds (Receive)', () => <Receive />, () => readTransactions],
  ['A proposal (Proposal)', () => <ProposalScreen />, () => getProposalDetail],
  ['Signing evidence (Ceremonies)', () => <Ceremonies embedded />, () => vaultCeremonies],
]

describe('a locked vault is asked for its passphrase, never read as a failure (#439)', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    setSelectedVault(GK)
    getVault.mockResolvedValue(vault); getProposals.mockResolvedValue([]); getLedger.mockResolvedValue([])
    readTransactions.mockResolvedValue([]); health.mockResolvedValue(true)
    getProposalDetail.mockResolvedValue(null); getBalance.mockResolvedValue(null); vaultCeremonies.mockResolvedValue([])
  })
  afterEach(async () => { cleanup(); vi.clearAllMocks(); clearReadSecret(GK); await deleteVault(GK).catch(() => {}) })

  for (const [name, el, read] of screens) {
    it(`${name}: nothing is read while locked, and it reads once the passphrase lands`, async () => {
      await save(true)
      mount(el())
      await settle()
      expect(read()).not.toHaveBeenCalled()
      act(() => unlock())
      await waitFor(() => expect(read()).toHaveBeenCalled())
    })
  }

  it('Approvals never says "Could not read the proposals" on a locked vault', async () => {
    await save(true)
    getProposals.mockResolvedValue(null) // what a 401 becomes
    mount(<Proposals embedded />)
    await settle()
    expect(screen.queryByText(en('proposals.unreadTitle'))).toBeNull()
  })

  it('a proposal on a locked vault is never "Could not read this proposal", nor the evidence a failed read', async () => {
    await save(true)
    // What the real readers do with a 401: record it as denied, and answer null.
    getProposalDetail.mockImplementation(async () => { recordRead('/api/vault/proposals', 'denied', 'coordinator'); return null })
    vaultCeremonies.mockImplementation(async () => { recordRead('/api/vault/ceremonies', 'denied', 'coordinator'); return null })
    mount(<ProposalScreen />)
    await settle()
    expect(screen.queryByText(en('proposal.unreadTitle'))).toBeNull()
    cleanup()
    mount(<Ceremonies embedded />)
    await settle()
    expect(screen.queryByText(en('ceremonies.unreadTitle'))).toBeNull()
  })

  it('runs on the web path', () => { expect(IS_NET).toBe(true) })

  it('an open vault (no S on this device) is read at once', async () => {
    await save(false)
    mount(<Proposals embedded />)
    await waitFor(() => expect(getProposals).toHaveBeenCalled())
  })
})
