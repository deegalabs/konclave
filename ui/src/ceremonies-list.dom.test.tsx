// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// The evidence list carried a txid and a digest and nothing a treasurer recognises. Each record that
// reached the chain now shows the proposal it paid (same txid): its document, its amount, a link.
// The join happens on the screen, from two lists the device already reads.

const vaultCeremonies = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
vi.mock('./helper', async (orig) => ({ ...(await orig<typeof import('./helper')>()), vaultCeremonies }))
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getLedger, getSelectedVault: () => 'v' }))

const { default: Ceremonies } = await import('./screens/Ceremonies')

const TX1 = 'a'.repeat(64)
const rent = { id: 'p1', vault_id: 'v', kind: 'payment', state: 'sent', proposer: 'Alice', memo: 'October rent', to_address: 'u1rent', value_zat: 150000000, value_zec: '1.5', created_at: 1759300000, txid: TX1, is_public: false, approvals: ['Alice', 'Bob'], refusals: [], approvals_count: 2 }

describe('the signing evidence names the payment it belongs to', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    vaultCeremonies.mockResolvedValue([
      { vault_id: 'v', sighash: 'b'.repeat(64), signatures: ['c'.repeat(128)], txid: TX1, dry_run: false, created_at_unix: 1759300100 },
      { vault_id: 'v', sighash: 'd'.repeat(64), signatures: [], txid: null, dry_run: true, created_at_unix: 1759200000 },
    ])
    getLedger.mockResolvedValue([rent])
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('a broadcast record shows the proposal with its txid: document, amount and a link to it', async () => {
    render(<MemoryRouter><I18nProvider><Ceremonies /></I18nProvider></MemoryRouter>)
    expect(await screen.findByText('October rent')).toBeTruthy()
    expect(screen.getByText('1.5000 ZEC').closest('.secret')).toBeTruthy() // the amount hides with every other amount
    expect(screen.getByRole('link', { name: `${en('ceremonies.viewProposal')} October rent` })).toBeTruthy() // the name carries the document, so two records never read alike
  })

  it('arriving from a proposal, its record is named, focused and marked as the current one', async () => {
    render(<MemoryRouter initialEntries={[{ pathname: '/activity', state: { tab: 'evidence', txid: TX1 } }]}><I18nProvider><Ceremonies embedded /></I18nProvider></MemoryRouter>)
    const tag = await screen.findByText(en('ceremonies.thisPayment'))
    const row = tag.closest('li')!
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(document.activeElement).toBe(row)
  })
})
