// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// #315 review: the decision was tested as a function and the screen as source text. This mounts the
// real screen in a simulated browser against a coordinator that does not answer, clicks "Try again"
// once it does, and reads what a member would see at each step.
const health = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
const getVault = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), health, getVault, IS_NET: true }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))

const { default: Members } = await import('./screens/Members')

const vault = {
  id: 'v', name: 'Vault', threshold: 2, total: 3, members: 3, group_pubkey: 'v', orchard_address: 'u1x',
  member_list: [{ name: 'Alice', pubkey: 'Alice' }, { name: 'Bob', pubkey: 'Bob' }, { name: 'Carol', pubkey: 'Carol' }],
  members_read: true,
}

const mount = () => render(<MemoryRouter><I18nProvider><Members /></I18nProvider></MemoryRouter>)

describe('the Members screen in a browser, with the coordinator offline then back (#315)', () => {
  beforeEach(() => { health.mockReset(); getVault.mockReset() })
  afterEach(() => cleanup())

  it('says the list could not be read, offers a retry, and shows the roster after one that works', async () => {
    health.mockResolvedValueOnce(false)
    mount()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(en('members.unreadTitle'))
    expect(alert.className).toContain('hint warn')
    expect(screen.queryByText(en('members.roleShareVote'))).toBeNull()
    expect(screen.getByText(en('members.footUnread'))).toBeTruthy()

    health.mockResolvedValueOnce(true)
    getVault.mockResolvedValueOnce(vault)
    fireEvent.click(screen.getByRole('button', { name: en('members.retry') }))
    await waitFor(() => expect(screen.getByText('Alice')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getAllByText(en('members.roleShareVote'))).toHaveLength(3)
    expect(screen.getByText('3 members · quorum 2-of-3')).toBeTruthy()
  })

  it('a list that came from the device, not the coordinator, is not shown as read', async () => {
    health.mockResolvedValueOnce(true)
    getVault.mockResolvedValueOnce({ ...vault, members_read: false })
    mount()
    await screen.findByRole('alert')
    expect(screen.queryByText(en('members.roleShareVote'))).toBeNull()
  })

  it('after a retry that fails again, focus is on the message, not lost at the top of the page', async () => {
    health.mockResolvedValue(false)
    mount()
    await screen.findByRole('alert')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('members.retry') })) })
    const alert = await screen.findByRole('alert')
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })
})
