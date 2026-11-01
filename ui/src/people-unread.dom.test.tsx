// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./toast', () => ({ useToast: () => ({ ok() {}, warn() {}, err() {}, info() {} }) }))
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import { recordRead } from './read-failure'
const en = (k: string): string => dict[k] ?? k

// The people register drew an empty list when it could not be read, as if nobody were registered.
// It now says that the list could not be read, and why, with a way to try again (#320, through the
// shared ReadState).

const getBeneficiaries = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getBeneficiaries, getVault, IS_NET: false }))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))

const { default: People } = await import('./screens/People')

describe('the people register says when it could not be read', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [], group_pubkey: 'v', orchard_address: 'u1x' })
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('a failed read is said with its reason and a retry, not drawn as an empty register', async () => {
    getBeneficiaries.mockResolvedValueOnce(null).mockResolvedValue([])
    recordRead('/api/beneficiaries', 'denied', 'bridge')
    render(<MemoryRouter><I18nProvider><People /></I18nProvider></MemoryRouter>)
    await screen.findByText(en('people.unreadTitle')) // the screen's own title over the shared ReadState
    expect(screen.getByText(en('read.denied').replace('{who}', en('read.who.bridge')), { exact: false })).toBeTruthy() // names who was asked
    expect(screen.getByRole('button', { name: en('people.register') }).hasAttribute('disabled')).toBe(true) // no registering into a list you cannot see
    expect(screen.queryByText(en('people.empty'))).toBeNull()
    recordRead('/api/beneficiaries', null)
    fireEvent.click(screen.getByRole('button', { name: en('read.retry') }))
    await screen.findByText(en('people.empty'))
  })
})
