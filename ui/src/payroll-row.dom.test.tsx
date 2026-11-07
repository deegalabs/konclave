// @vitest-environment jsdom
// A row's identity is its own, not its index: the survivor of a delete never shows the deleted row's text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'

const createPayroll = vi.hoisted(() => vi.fn())
const health = vi.hoisted(() => vi.fn())
const getBeneficiaries = vi.hoisted(() => vi.fn())
const getLedger = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const readBalance = vi.hoisted(() => vi.fn())
const addBeneficiary = vi.hoisted(() => vi.fn())
const previewPayroll = vi.hoisted(() => vi.fn())
const getProposals = vi.hoisted(() => vi.fn())
const getProposalDetail = vi.hoisted(() => vi.fn())
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()), createPayroll, health, getBeneficiaries, getLedger, getVault, readBalance, addBeneficiary, previewPayroll,
  getProposals, getProposalDetail, IS_NET: false,
}))
vi.mock('./storage', async (orig) => ({ ...(await orig<typeof import('./storage')>()), listVaults: async () => [] }))
vi.mock('./toast', () => ({ useToast: () => ({ ok: () => {}, err: () => {}, warn: () => {}, info: () => {} }) }))

const { default: NewPayroll } = await import('./screens/NewPayroll')
const { setSelectedVault } = await import('./api')
const { draftKey } = await import('./payroll-draft')
const DRAFT = draftKey('v')

const A = 'u1' + 'a'.repeat(76)
const B = 'u1' + 'b'.repeat(76)
const C = 'u1' + 'c'.repeat(76)
const T = 't1' + 'd'.repeat(33)
const SAVED = 'u1' + 's'.repeat(76)

const mount = async () => {
  const r = render(<MemoryRouter><I18nProvider><NewPayroll /></I18nProvider></MemoryRouter>)
  await screen.findByRole('button', { name: dict['payroll.addRow'] })
  return r
}
const lines = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('.plr-line'))
const addRow = () => fireEvent.click(screen.getByRole('button', { name: dict['payroll.addRow'] }))
const typeAddr = (c: HTMLElement, i: number, v: string) => {
  const input = lines(c)[i]!.querySelector<HTMLInputElement>('input.rcb-input')!
  fireEvent.change(input, { target: { value: v } })
  fireEvent.mouseDown(document.body) // leaves the field, closes the dropdown, as a click elsewhere does
}
const setVal = (c: HTMLElement, i: number, v: string) => fireEvent.change(lines(c)[i]!.querySelector('input.plr-val')!, { target: { value: v } })
const del = (c: HTMLElement, i: number) => fireEvent.click(lines(c)[i]!.querySelector('button.plr-del')!)
/** What a person reads in each row. */
const shown = (c: HTMLElement) => lines(c).map((l) => {
  const input = l.querySelector<HTMLInputElement>('input.rcb-input')
  return {
    recipient: input ? input.value : l.querySelector('.rcb-picked')!.textContent,
    value: l.querySelector<HTMLInputElement>('input.plr-val')!.value,
    hint: l.querySelector('.rcb-ok, .hint.warn')?.textContent ?? null,
  }
})
/** The `rows` state, read from the draft the screen autosaves from it. */
const state = () => JSON.parse(localStorage.getItem(DRAFT)!).rows as { address: string; value: string; label: string }[]
const submit = async () => {
  const b = screen.getByRole<HTMLButtonElement>('button', { name: dict['payroll.submitBtn'] })
  await waitFor(() => expect(b.disabled).toBe(false))
  fireEvent.click(b)
  await waitFor(() => expect(createPayroll).toHaveBeenCalled())
  return createPayroll.mock.calls[0]![1] as { address: string; value_zec: string; label?: string }[]
}

describe('payroll: deleting a row keeps each row its own text', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    setSelectedVault('v')
    getProposals.mockResolvedValue([])
    createPayroll.mockReset()
    createPayroll.mockResolvedValue({ ok: false, error: 'stop here' })
    health.mockResolvedValue(true)
    getBeneficiaries.mockResolvedValue([{ id: 'b1', name: 'Saved Sam', address: SAVED, memo: '' }])
    getLedger.mockResolvedValue([])
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa', threshold: 2, total: 3, members: 3, member_list: [{ name: 'Alice' }], group_pubkey: 'v', orchard_address: 'u1x' })
    readBalance.mockResolvedValue({ configured: true, spendable_zat: 500000000, total_zat: 500000000 })
  })
  afterEach(() => { cleanup(); localStorage.clear() })

  it('S1 two pasted rows, delete row 1: the survivor shows B', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, A); setVal(c, 0, '0.1'); addRow(); typeAddr(c, 1, B); setVal(c, 1, '0.2')
    del(c, 0)
    const sent = await submit()
    expect(shown(c)).toHaveLength(1)
    expect(shown(c)[0]!.recipient).toBe(B)
    expect(state()[0]!.address).toBe(B)
    expect(state()[0]).not.toHaveProperty('k') // the identity is the screen's, not the draft's
    expect(sent).toHaveLength(1)
    expect(sent[0]!.address).toBe(B)
    expect(sent[0]!.value_zec).toBe('0.2')
  })

  it('S2 three rows, delete row 1: B and C each beside its own amount', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, A); setVal(c, 0, '0.1'); addRow(); typeAddr(c, 1, B); setVal(c, 1, '0.2'); addRow(); typeAddr(c, 2, C); setVal(c, 2, '0.3')
    del(c, 0)
    const sent = await submit()
    expect(shown(c).map((s) => s.recipient)).toEqual([B, C])
    expect(shown(c).map((s) => s.value)).toEqual(['0.2', '0.3'])
    expect(sent.map((l) => l.address)).toEqual([B, C])
  })

  it('S3 delete row 1 twice: only C is left, and it is what is shown', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, A); setVal(c, 0, '0.1'); addRow(); typeAddr(c, 1, B); setVal(c, 1, '0.2'); addRow(); typeAddr(c, 2, C); setVal(c, 2, '0.3')
    del(c, 0); del(c, 0)
    const sent = await submit()
    expect(shown(c).map((s) => s.recipient)).toEqual([C])
    expect(sent.map((l) => l.address)).toEqual([C])
  })

  it('S4 text and hint agree: the survivor shows B under a shielded hint', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, T); setVal(c, 0, '0.1'); addRow(); typeAddr(c, 1, B); setVal(c, 1, '0.2')
    del(c, 0)
    expect(shown(c)[0]!.recipient).toBe(B)
    expect(state()[0]!.address).toBe(B)
    expect(shown(c)[0]!.hint).toBe(dict['rec.shieldedOk'])
  })

  it('S5 the reverse: the survivor shows the public t1 under the public warning', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, A); setVal(c, 0, '0.1'); addRow(); typeAddr(c, 1, T); setVal(c, 1, '0.2')
    del(c, 0)
    const sent = await submit()
    expect(shown(c)[0]!.recipient).toBe(T)
    expect(sent[0]!.address).toBe(T)
    expect(shown(c)[0]!.hint).toBe(dict['rec.publicWarn'])
  })

  it('S6 a lone row, deleted: the empty row shows nothing', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, A); setVal(c, 0, '0.1')
    del(c, 0)
    expect(shown(c)[0]!.recipient).toBe('')
    expect(state()[0]!.address).toBe('')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: dict['payroll.submitBtn'] }).disabled).toBe(true)
  })

  it('S7 a half-typed search in row 1 does not leak into the survivor', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, 'Sa'); addRow(); typeAddr(c, 1, B); setVal(c, 1, '0.2')
    del(c, 0)
    expect(shown(c)[0]!.recipient).toBe(B)
    expect(state()[0]!.address).toBe(B)
  })

  it('S8 save this recipient: the name is stored with the address on screen', async () => {
    addBeneficiary.mockImplementation(async (name: string, address: string) => ({ ok: true, beneficiary: { id: 'n', name, address, memo: '' } }))
    const { container: c } = await mount()
    typeAddr(c, 0, A); setVal(c, 0, '0.1'); addRow(); typeAddr(c, 1, B); setVal(c, 1, '0.2')
    del(c, 0)
    expect(shown(c)[0]!.recipient).toBe(B)
    fireEvent.click(c.querySelector('button.rcb-savesuggest')!)
    fireEvent.change(c.querySelector('.rcb-savebox input')!, { target: { value: 'Ana (owner of A)' } })
    fireEvent.click(c.querySelector('.rcb-savebox .btn.ok')!)
    await waitFor(() => expect(addBeneficiary).toHaveBeenCalled())
    expect(addBeneficiary.mock.calls[0]![0]).toBe('Ana (owner of A)')
    expect(addBeneficiary.mock.calls[0]![1]).toBe(B)
    await screen.findByText('Ana (owner of A)')
  })

  it('S9 a restored draft: delete row 1, the survivor shows its own address', async () => {
    localStorage.setItem(DRAFT, JSON.stringify({ competencia: '', description: '', rows: [
      { label: '', address: A, value: '0.1', memo: '' }, { label: '', address: B, value: '0.2', memo: '' }] }))
    const { container: c } = await mount()
    expect(shown(c).map((s) => s.recipient)).toEqual([A, B])
    del(c, 0)
    expect(shown(c)).toHaveLength(1)
    expect(shown(c)[0]!.recipient).toBe(B)
    expect(shown(c)[0]!.value).toBe('0.2')
  })

  it('S10 a restored draft with rows saved by an older build (no identity) still gets one each', async () => {
    localStorage.setItem(DRAFT, JSON.stringify({ rows: [{ address: A }, { address: B }, { address: C }] }))
    const { container: c } = await mount()
    typeAddr(c, 0, A) // pasted over the restored row, so the field holds local text
    del(c, 0)
    expect(shown(c).map((s) => s.recipient)).toEqual([B, C])
  })

  it('S11 CSV import over a row with typed text: the imported rows show their own addresses', async () => {
    previewPayroll.mockResolvedValue({ errors: [], lines: [
      { label: '', address: B, value_zec: '0.2', memo: '' }, { label: '', address: C, value_zec: '0.3', memo: '' }] })
    const { container: c } = await mount()
    typeAddr(c, 0, A); setVal(c, 0, '0.1')
    fireEvent.click(screen.getByRole('button', { name: dict['payroll.importCsv'] }))
    fireEvent.click(screen.getByRole('button', { name: dict['payroll.csvRead'] }))
    await waitFor(() => expect(shown(c)).toHaveLength(2))
    expect(shown(c).map((s) => s.recipient)).toEqual([B, C])
    del(c, 0)
    expect(shown(c).map((s) => s.recipient)).toEqual([C])
  })

  it('S12 lines copied from a previous payroll: retyping row 1 and deleting it leaves row 2 its own address', async () => {
    const OLD1 = 'u1' + 'e'.repeat(76)
    const OLD2 = 'u1' + 'f'.repeat(76)
    const past = { id: 'f1', vault_id: 'v', kind: 'payroll', state: 'sent', proposer: 'Alice', memo: 'March payroll', is_public: false,
      approvals: ['Alice', 'Bob'], refusals: [], approvals_count: 2, value_zat: 30_000_000, value_zec: '0.3', created_at: 1_760_000_000 }
    getLedger.mockResolvedValue([past])
    getProposalDetail.mockResolvedValue({ proposal: past, lines: [
      { label: '', address: OLD1, value_zat: 10_000_000, value_zec: '0.1', memo: '', is_public: false },
      { label: '', address: OLD2, value_zat: 20_000_000, value_zec: '0.2', memo: '', is_public: false }] })
    const { container: c } = await mount()
    fireEvent.click(await screen.findByRole('button', { name: `${dict['payroll.startFromThis']}: March payroll` }))
    await waitFor(() => expect(shown(c).map((s) => s.recipient)).toEqual([OLD1, OLD2]))
    typeAddr(c, 0, A) // row 1 now holds text of its own
    del(c, 0)
    expect(shown(c).map((s) => s.recipient)).toEqual([OLD2])
    expect(shown(c)[0]!.value).toBe('0.2')
    expect(state()[0]!.address).toBe(OLD2)
  })

  it('S13 lines added from the registry under a half-typed row: deleting that row leaves each payee its own name', async () => {
    getBeneficiaries.mockResolvedValue([{ id: 'b1', name: 'Saved Sam', address: SAVED, memo: '' }, { id: 'b2', name: 'Other Olga', address: B, memo: '' }])
    const { container: c } = await mount()
    typeAddr(c, 0, 'Ol'); setVal(c, 0, '0.1') // a half-typed search, not empty, so it is not replaced
    fireEvent.click(screen.getByRole('button', { name: dict['payroll.fromRegistry'] }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /Saved Sam/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Other Olga/ }))
    fireEvent.click(screen.getByRole('button', { name: dict['payroll.registryAdd']!.replace('{n}', '2') }))
    await waitFor(() => expect(shown(c)).toHaveLength(3))
    del(c, 0)
    const after = shown(c)
    expect(after).toHaveLength(2)
    expect(after[0]!.recipient).toContain('Saved Sam')
    expect(after[1]!.recipient).toContain('Other Olga')
    expect(state().map((r) => r.address)).toEqual([SAVED, B])
  })

  it('CONTROL C0 row 1 pasted, row 2 SAVED: the survivor renders the chip, the stale text is hidden', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, A); setVal(c, 0, '0.1'); addRow()
    typeAddr(c, 1, SAVED); setVal(c, 1, '0.2') // an address in the registry resolves to the payee
    del(c, 0)
    const sent = await submit()
    expect(shown(c)[0]!.recipient).toContain('Saved Sam')
    expect(sent[0]!.address).toBe(SAVED)
  })

  it('CONTROL C1 row 1 SAVED, row 2 pasted: survivor shows B (a pick clears q)', async () => {
    const { container: c } = await mount()
    typeAddr(c, 0, SAVED); setVal(c, 0, '0.1'); addRow(); typeAddr(c, 1, B); setVal(c, 1, '0.2')
    del(c, 0)
    const sent = await submit()
    expect(shown(c)[0]!.recipient).toBe(B)
    expect(sent[0]!.address).toBe(B)
  })

  it('CONTROL C2 both SAVED by clicking the option: survivor shows the second payee', async () => {
    getBeneficiaries.mockResolvedValue([{ id: 'b1', name: 'Saved Sam', address: SAVED, memo: '' }, { id: 'b2', name: 'Other Olga', address: B, memo: '' }])
    const { container: c } = await mount()
    fireEvent.focus(lines(c)[0]!.querySelector('input.rcb-input')!)
    fireEvent.click(await screen.findByRole('option', { name: /Saved Sam/ })); setVal(c, 0, '0.1'); addRow()
    fireEvent.focus(lines(c)[1]!.querySelector('input.rcb-input')!)
    fireEvent.click(await screen.findByRole('option', { name: /Other Olga/ })); setVal(c, 1, '0.2')
    del(c, 0)
    const sent = await submit()
    expect(shown(c)[0]!.recipient).toContain('Other Olga')
    expect(sent[0]!.address).toBe(B)
  })

  it('CONTROL C3 pasted, then the "pasted address" option clicked in row 1: q is cleared, survivor shows B', async () => {
    const { container: c } = await mount()
    fireEvent.change(lines(c)[0]!.querySelector('input.rcb-input')!, { target: { value: A } })
    fireEvent.click(await screen.findByRole('option')); setVal(c, 0, '0.1'); addRow(); typeAddr(c, 1, B); setVal(c, 1, '0.2')
    del(c, 0)
    expect(shown(c)[0]!.recipient).toBe(B)
  })
})