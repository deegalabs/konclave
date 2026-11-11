// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
import type { AnalysesReport } from './analysesReport'
const en = (k: string): string => dict[k] ?? k

// The export buttons on the Analyses screen, clicked. The file is built from what the screen read:
// the balance it draws and the vault's name. A browser that refuses the save is told to the member.

const getLedger = vi.hoisted(() => vi.fn())
const readBalance = vi.hoisted(() => vi.fn())
const getVault = vi.hoisted(() => vi.fn())
const downloadBlob = vi.hoisted(() => vi.fn())
const polls = vi.hoisted(() => [] as (() => void)[])
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), getLedger, readBalance, getVault }))
vi.mock('./download', () => ({ downloadBlob }))
vi.mock('./vault-readable', () => ({ useVaultReadable: () => true }))
vi.mock('./usePoll', async (orig) => ({
  ...(await orig<typeof import('./usePoll')>()),
  startVisiblePoll: (fn: () => void) => { polls.push(fn); return () => {} },
}))
const exportAnalyses = vi.hoisted(() => vi.fn())
vi.mock('./analysesReport', async (orig) => {
  const real = await orig<typeof import('./analysesReport')>()
  exportAnalyses.mockImplementation(real.exportAnalyses)
  return { ...real, exportAnalyses }
})

const { default: Analyses } = await import('./screens/Analyses')

const ZEC = 100_000_000
const sent = { id: 'p1', vault_id: 'v', kind: 'payment', state: 'sent', proposer: 'Ana', value_zat: ZEC, value_zec: '1', created_at: 1759300000, is_public: false, approvals: [], refusals: [], approvals_count: 0 }
const show = () => render(<MemoryRouter><I18nProvider><Analyses /></I18nProvider></MemoryRouter>)
const lastReport = () => exportAnalyses.mock.calls.at(-1)![0] as AnalysesReport

describe('exporting the Analyses', () => {
  beforeEach(() => {
    localStorage.setItem('konclave.locale', 'en')
    getLedger.mockResolvedValue([sent])
    readBalance.mockResolvedValue({ configured: true, total_zat: 7 * ZEC, spendable_zat: 7 * ZEC })
    getVault.mockResolvedValue({ id: 'v', name: 'Caixa da comunidade' })
    downloadBlob.mockReturnValue(true)
  })
  afterEach(() => { cleanup(); localStorage.clear(); polls.length = 0; vi.clearAllMocks() })

  it('builds the file from the balance the screen read and the vault it is in', async () => {
    show()
    const button = await screen.findByRole('button', { name: en('analyses.exportHtml') })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    const r = lastReport()
    expect(r.vaultName).toBe('Caixa da comunidade')
    expect(r.sections[0]!.rows[0]!).toMatchObject({ label: en('analyses.inVault'), value: '7.00000000' })
    expect(downloadBlob.mock.calls[0]![0]).toBe('konclave-caixa-da-comunidade-analyses.html')
    expect(await screen.findByText(en('analyses.exported'))).toBeTruthy()
  })

  it('says so when the browser does not save the file', async () => {
    downloadBlob.mockReturnValue(false)
    show()
    const button = await screen.findByRole('button', { name: en('analyses.exportXlsx') })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)
    expect((await screen.findByRole('alert')).textContent).toBe(en('analyses.exportFailed'))
    expect(screen.queryByText(en('analyses.exported'))).toBeNull()
  })

  it('asks for the vault name again when the first read did not answer', async () => {
    getVault.mockResolvedValueOnce(null)
    show()
    const button = await screen.findByRole('button', { name: en('analyses.exportHtml') })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    polls.forEach((f) => f())
    await waitFor(() => expect(getVault).toHaveBeenCalledTimes(2))
    fireEvent.click(button)
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    expect(lastReport().vaultName).toBe('Caixa da comunidade')
  })
})
