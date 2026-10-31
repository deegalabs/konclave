// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #292: the list hid a sent proposal the moment it went out, came in backend order with no
// "needs you" bucket and no expiry sort, and drew an empty list when it could not read. This mounts
// the real screen over a fake coordinator and reads the groups and their order.

const getProposals = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const readTransactions = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getProposals, getVault, readTransactions, IS_NET: false }))
const listVaults = vi.hoisted(() => vi.fn())
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults }))

const { default: Proposals } = await import('./screens/Proposals')

const now = Math.floor(Date.now() / 1000)
const base = { vault_id: 'v', proposer: 'Alice', is_public: false, refusals: [], kind: 'payment', to_address: 'u1x', value_zat: 100000000, value_zec: '1', created_at: now - 1000 }
const far = { ...base, id: 'a', state: 'awaiting', memo: 'Far deadline', approvals: ['Alice'], approvals_count: 1, expiry_unix: now + 5 * 86400 }
const near = { ...base, id: 'b', state: 'awaiting', memo: 'Near deadline', approvals: ['Alice'], approvals_count: 1, expiry_unix: now + 86400 }
const voted = { ...base, id: 'c', state: 'awaiting', memo: 'Bob already voted', approvals: ['Bob'], approvals_count: 1, expiry_unix: now + 2 * 86400 }
const ready = { ...base, id: 'r', state: 'ready', memo: 'Ready rent', approvals: ['Alice', 'Bob'], approvals_count: 2, expiry_unix: now + 3 * 86400 }
const sent = { ...base, id: 's', state: 'sent', memo: 'Sent rent', approvals: ['Alice', 'Bob'], approvals_count: 2, txid: 'f'.repeat(64) }
const closed = { ...base, id: 'x', state: 'rejected', memo: 'Refused chairs', approvals: [], approvals_count: 0 }

const mount = () => render(<MemoryRouter><I18nProvider><Proposals /></I18nProvider></MemoryRouter>)
const titlesUnder = (heading: string) => {
  const head = screen.getByText(heading).closest('.plist-head')!
  const list = head.nextElementSibling as HTMLElement
  return within(list).getAllByText(/./, { selector: '.plist-link' }).map((el) => el.textContent)
}

describe('the proposals list (#292)', () => {
  beforeEach(() => {
    readTransactions.mockReset()
    localStorage.setItem('konclave.locale', 'en')
    listVaults.mockResolvedValue([{ id: 'v', myName: 'Bob' }])
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: 'v', orchard_address: 'u1x' })
    readTransactions.mockResolvedValue([])
    getProposals.mockResolvedValue([far, sent, closed, voted, near, ready])
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('puts what needs this member first, soonest deadline first, then the rest, then the sent ones', async () => {
    mount()
    await screen.findByText('Near deadline')
    expect(titlesUnder(en('proposals.needsYou'))).toEqual(['Ready rent', 'Near deadline', 'Far deadline'])
    expect(titlesUnder(en('proposals.withOthers'))).toEqual(['Bob already voted'])
    expect(titlesUnder(en('proposals.sentAwaiting'))).toEqual(['Sent rent'])
    expect(screen.queryByText('Refused chairs')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en('proposals.showClosed').replace('{n}', '1') }))
    expect(screen.getByText('Refused chairs')).toBeTruthy()
    expect(screen.getByRole('button', { name: en('proposals.hideClosed').replace('{n}', '1') })).toBeTruthy()
    expect(within(screen.getByText('Ready rent').closest('.plist-row')!).getByText(en('desk.band.sign'))).toBeTruthy()
  })

  it('with no member name on the device, the stamps speak of the vault, never "Your vote"', async () => {
    listVaults.mockResolvedValue([])
    mount()
    await screen.findByText('Near deadline')
    expect(screen.getByText(en('proposals.readyToSign'))).toBeTruthy()
    expect(screen.queryByText(en('desk.band.vote'))).toBeNull()
    expect(within(screen.getByText('Ready rent').closest('.plist-row') as HTMLElement).getByText(en('stamp.ready'))).toBeTruthy()
    expect(within(screen.getByText('Near deadline').closest('.plist-row') as HTMLElement).getByText(en('stamp.awaiting'))).toBeTruthy()
  })

  it('a READY proposal past its deadline is closed on the device too, stamped expired, not first under "Sign"', async () => {
    const readyExpired = { ...ready, id: 'e', memo: 'Ready but late', expiry_unix: now - 60 }
    getProposals.mockResolvedValue([readyExpired, near])
    mount()
    await screen.findByText('Near deadline')
    expect(titlesUnder(en('proposals.needsYou'))).toEqual(['Near deadline'])
    fireEvent.click(screen.getByRole('button', { name: en('proposals.showClosed').replace('{n}', '1') }))
    const row = screen.getByText('Ready but late').closest('.plist-row') as HTMLElement
    expect(row.className).toContain('closed')
    expect(within(row).getByText(en('state.expired'))).toBeTruthy()
    expect(within(row).queryByText(en('desk.band.sign'))).toBeNull()
  })

  it('reads the transaction list only when a sent proposal exists, apart from the list', async () => {
    getProposals.mockResolvedValue([near, ready])
    mount()
    await screen.findByText('Near deadline')
    expect(readTransactions).not.toHaveBeenCalled()
    cleanup()
    getProposals.mockResolvedValue([near, sent])
    mount()
    await screen.findByText('Sent rent')
    await waitFor(() => expect(readTransactions).toHaveBeenCalled())
  })

  it('a sent proposal leaves the list once the chain has it in a block', async () => {
    readTransactions.mockResolvedValue([{ txid: 'f'.repeat(64), mined_height: 3500100 }])
    mount()
    await screen.findByText('Near deadline')
    await waitFor(() => expect(screen.queryByText('Sent rent')).toBeNull())
  })

  it('says when the list could not be read, instead of drawing an empty desk, and tries again', async () => {
    getProposals.mockResolvedValueOnce(null)
    mount()
    await screen.findByText(en('proposals.unreadTitle'))
    expect(screen.queryByText(en('proposals.nothingAwaiting'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en('proposals.retry') }))
    await screen.findByText('Near deadline')
  })
})
