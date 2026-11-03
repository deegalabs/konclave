// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

/* #293: the Payroll screen read the raw spendable balance, so a second payroll against funds an open
 * proposal already holds validated and died at signing. fits-like-pay.test.ts pins the source (the
 * screen calls the shared rule); this mounts the screen in a browser and reads the result, because
 * a gate fed the raw balance again would leave every regex there green. */

const health = vi.hoisted(() => vi.fn())
const getBeneficiaries = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const readBalance = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), health, getBeneficiaries, getLedger, getVault, getProposals, readBalance, IS_NET: true,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: NewPayroll } = await import('./screens/NewPayroll')

const ADDR = 'u1' + 'q'.repeat(76)
const ONE_ZEC = 100_000_000
// An open proposal (awaiting) holding 0.9 of the vault's 1 ZEC.
const holding = {
  id: 'h', vault_id: 'v', kind: 'payment', state: 'awaiting', proposer: 'Alice', memo: 'Rent', is_public: false,
  approvals: ['Alice'], refusals: [], approvals_count: 1, value_zat: 90_000_000, value_zec: '0.9', to_address: ADDR,
}

const mount = () => render(<MemoryRouter><I18nProvider><NewPayroll /></I18nProvider></MemoryRouter>)
const fillOneLine = async () => {
  const to = (await screen.findAllByRole('combobox'))[0]!
  fireEvent.change(to, { target: { value: ADDR } })
  fireEvent.change(screen.getAllByLabelText(en('payroll.colValue'))[0]!, { target: { value: '0.5' } })
}
const submit = () => screen.getByRole('button', { name: en('payroll.submitBtn') }) as HTMLButtonElement

describe('a reservation disables the payroll button, in the browser (#293)', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('konclave.locale', 'en')
    health.mockResolvedValue(true)
    getBeneficiaries.mockResolvedValue([])
    getLedger.mockResolvedValue([])
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }], group_pubkey: 'v', orchard_address: ADDR })
    readBalance.mockResolvedValue({ configured: true, total_zat: ONE_ZEC, spendable_zat: ONE_ZEC, total_zec: '1', spendable_zec: '1' })
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('0.5 ZEC fits the raw balance but not what is free: the button is disabled and the block names the reservation', async () => {
    getProposals.mockResolvedValue([holding])
    mount()
    await fillOneLine()
    await waitFor(() => expect(submit().disabled).toBe(true))
    const block = document.getElementById('payroll-block')!
    expect(block.textContent).toContain('0.9')
    expect(block.textContent).toContain(en('money.blockReserved').slice(0, 24))
    expect(submit().getAttribute('aria-describedby')).toContain('payroll-block')
  })

  it('the same line with nothing open proposes', async () => {
    getProposals.mockResolvedValue([])
    mount()
    await fillOneLine()
    await waitFor(() => expect(submit().disabled).toBe(false))
    expect(document.getElementById('payroll-block')!.textContent).toBe('')
  })
})
