// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// The real vault list over a stored record. What a member can reach from a card is what these read.
const h = vi.hoisted(() => ({ list: vi.fn(), meta: vi.fn(async () => {}) }))
vi.mock('./screens/NetVault', () => ({ default: () => null }))
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), helperConfigured: () => true }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health: async () => false, getVaults: async () => [], isVaultUnlocked: () => true, setSelectedVault: vi.fn() }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: h.list, readVaults: h.list, updateVaultMeta: h.meta }))
const Vaults = (await import('./screens/Vaults')).default

const GK = 'ab'.repeat(32)
const rec = (over: object) => ({ id: GK, name: 'V', governance: 'quorum', myName: 'A', creatorName: 'A', groupKey: GK, address: '', roster: ['A', 'B'], createdAt: 1, threshold: 2, total: 2, cp: 3, ...over })
const show = () => render(<MemoryRouter><I18nProvider><ToastProvider><Vaults /></ToastProvider></I18nProvider></MemoryRouter>)

describe('the vault card', () => {
  beforeEach(() => { h.meta.mockClear() })
  afterEach(cleanup)

  it('a protocol-3 creation with no record of everyone saving keeps a way forward', async () => {
    h.list.mockResolvedValue([rec({ pending: true })])
    show()
    await screen.findByText(en('vaults.pendingConfirm'))
  })
  it('the compare button records it, and shows the address', async () => {
    h.list.mockResolvedValue([rec({ address: 'u1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiversState: 'verified', viewingFingerprint: 'CODEX' })])
    const opened = vi.fn()
    const { container } = show()
    container.addEventListener('click', opened)
    const go = await screen.findByText(en('set.viewingCodeSeen'))
    expect(screen.queryByText(en('vaults.receive'), { exact: false })).toBeNull()
    fireEvent.click(go)
    await waitFor(() => expect(h.meta).toHaveBeenCalledWith(GK, { codeCompared: true }))
  })
  it('a write that fails says so, and the button still works', async () => {
    h.list.mockResolvedValue([rec({ address: 'u1aaa', receiversState: 'verified', viewingFingerprint: 'CODEX' })])
    h.meta.mockRejectedValueOnce(new Error('x'))
    show()
    fireEvent.click(await screen.findByText(en('set.viewingCodeSeen')))
    // By its words: the toast region is an empty role="alert" too, so a role alone proves nothing.
    const said = await screen.findByText(en('export.errGeneric'))
    expect(said.closest('[role="alert"]')).toBeTruthy()
    expect(screen.getByText(en('set.viewingCodeSeen'))).toBeTruthy()
  })
  it('a second try clears the first failure before it writes again', async () => {
    h.list.mockResolvedValue([rec({ address: 'u1aaa', receiversState: 'verified', viewingFingerprint: 'CODEX' })])
    h.meta.mockRejectedValueOnce(new Error('x'))
    h.meta.mockImplementationOnce(() => new Promise<void>(() => {}))
    show()
    fireEvent.click(await screen.findByText(en('set.viewingCodeSeen')))
    await screen.findByText(en('export.errGeneric'))
    fireEvent.click(screen.getByText(en('set.viewingCodeSeen')))
    await waitFor(() => expect(screen.queryByText(en('export.errGeneric'))).toBeNull())
  })
})
