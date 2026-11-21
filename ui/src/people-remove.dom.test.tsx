// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const toast = vi.hoisted(() => ({ ok: vi.fn(), warn: vi.fn(), err: vi.fn(), info: vi.fn() }))
vi.mock('./toast', () => ({ useToast: () => toast }))
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #320: the register says a removal that landed (a toast), and must say one that did not just as
// clearly; a failed removal used to stay silent beside the new success notice.

const getBeneficiaries = vi.hoisted(() => vi.fn())
const deleteBeneficiary = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getBeneficiaries, deleteBeneficiary, getVault, IS_NET: false }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))

const { default: People } = await import('./screens/People')
const ana = { id: 'b1', name: 'Ana', address: 'u1' + 'q'.repeat(76), memo: '' }

describe('removing a person from the register', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: 'v', orchard_address: 'u1x' })
    getBeneficiaries.mockResolvedValue([ana])
    Object.values(toast).forEach((f) => f.mockReset())
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  const remove = async () => {
    render(<MemoryRouter><I18nProvider><People /></I18nProvider></MemoryRouter>)
    await screen.findByText('Ana')
    fireEvent.click(screen.getByTitle(en('common.remove')))
    fireEvent.click(screen.getByRole('button', { name: en('people.confirmDeleteAction') }))
  }

  it('a removal that did not land says so, and claims no success', async () => {
    deleteBeneficiary.mockResolvedValue({ ok: false, error: 'not removed' })
    await remove()
    await waitFor(() => expect(toast.err).toHaveBeenCalledWith(en('toast.personRemoveFailed').replace('{name}', 'Ana')))
    expect(toast.ok).not.toHaveBeenCalled()
  })

  it('a removal that landed says so', async () => {
    deleteBeneficiary.mockResolvedValue({ ok: true })
    await remove()
    await waitFor(() => expect(toast.ok).toHaveBeenCalledWith(en('toast.personRemoved').replace('{name}', 'Ana')))
    expect(toast.err).not.toHaveBeenCalled()
  })

  it('on the local bridge with no selection, removing waits until the vault is known', async () => {
    let answer: (v: unknown) => void = () => {}
    getVault.mockReturnValue(new Promise((r) => { answer = r }))
    render(<MemoryRouter><I18nProvider><People /></I18nProvider></MemoryRouter>)
    const del = await screen.findByTitle(en('common.remove')) as HTMLButtonElement
    expect(del.disabled).toBe(true)
    await act(async () => { answer({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: 'v', orchard_address: 'u1x' }) })
    await waitFor(() => expect((screen.getByTitle(en('common.remove')) as HTMLButtonElement).disabled).toBe(false))
  })
})
