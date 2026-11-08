// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from './i18n'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// What the screen does with a coordinator's answer: whatever record it leaves, nothing runs and no
// field shows until the member opens the form, and the repair runs only on their click.
const repair = vi.hoisted(() => vi.fn())
vi.mock('./vault-receivers', () => ({ repairVaultReceivers: repair }))
const { ReceiversRepair } = await import('./screens/ReceiversRepair')

const rec = { id: 'v', address: 'ua', receiversState: 'refused', viewingFingerprint: 'HELD', servedFingerprint: 'SERVED' } as never
const show = (r = rec) => render(<I18nProvider><ReceiversRepair rec={r} onDone={() => {}} /></I18nProvider>)

describe('the repair form', () => {
  beforeEach(() => { repair.mockReset(); repair.mockResolvedValue({ state: 'verified', address: 'x' }) })
  afterEach(cleanup)

  it('a refused record runs nothing and shows no field, and the lead says the device may be right', () => {
    const { container } = show()
    expect(repair).not.toHaveBeenCalled()
    expect(container.querySelector('input')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('HELD')
  })
  it('runs once, on the click, with what was typed', async () => {
    const { container } = show()
    fireEvent.click(screen.getByText(en('set.repairOpen')))
    expect(repair).not.toHaveBeenCalled()
    const [code, pass] = Array.from(container.querySelectorAll('input'))
    fireEvent.change(code!, { target: { value: 'AGREED' } })
    fireEvent.change(pass!, { target: { value: 'pw' } })
    expect(repair).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(en('set.repairGo')))
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledWith('v', 'pw', 'AGREED')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en('set.repairDone')))
    expect((pass as HTMLInputElement).value).toBe('')
  })
  it('says what it cannot know, and the words for a device with no code and a key that does not fit', () => {
    show({ ...(rec as object), viewingFingerprint: undefined } as never)
    expect(screen.getByRole('alert').textContent).toContain('SERVED')
    expect(screen.getByRole('alert').textContent).not.toContain(' - ')
    cleanup()
    show({ ...(rec as object), servedFingerprint: '' } as never)
    expect(screen.getByRole('alert').textContent).toContain(en('set.repairForeign'))
  })
  it('nothing renders on a record that is not refused, or holds no address', () => {
    expect(show({ ...(rec as object), receiversState: 'verified' } as never).container.textContent).toBe('')
    cleanup()
    expect(show({ ...(rec as object), address: undefined } as never).container.textContent).toBe('')
  })
  it('holds while it runs, runs once on a double click, and its outcome stays after the record changes', async () => {
    let finish: (v: unknown) => void = () => {}
    repair.mockReturnValue(new Promise((r) => { finish = r }))
    const tree = (r: never) => <I18nProvider><ReceiversRepair rec={r} onDone={() => {}} /></I18nProvider>
    const { container, rerender } = render(tree(rec))
    fireEvent.click(screen.getByText(en('set.repairOpen')))
    const [code, pass] = Array.from(container.querySelectorAll('input'))
    fireEvent.change(code!, { target: { value: 'AGREED' } })
    fireEvent.change(pass!, { target: { value: 'pw' } })
    const go = screen.getByText(en('set.repairGo'))
    fireEvent.click(go)
    fireEvent.click(go)
    expect(repair).toHaveBeenCalledTimes(1)
    // typing again while it runs starts nothing
    fireEvent.change(pass!, { target: { value: 'again' } })
    expect((go as HTMLButtonElement).disabled).toBe(true)
    finish({ state: 'verified', address: 'x' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en('set.repairDone')))
    rerender(tree({ ...(rec as object), receiversState: 'verified' } as never))
    expect(screen.getByRole('status').textContent).toBe(en('set.repairDone'))
  })
  it('a repair that throws says so and leaves the form usable', async () => {
    repair.mockRejectedValue(new Error('x'))
    const { container } = show()
    fireEvent.click(screen.getByText(en('set.repairOpen')))
    const [code, pass] = Array.from(container.querySelectorAll('input'))
    fireEvent.change(code!, { target: { value: 'AGREED' } })
    fireEvent.change(pass!, { target: { value: 'pw' } })
    fireEvent.click(screen.getByText(en('set.repairGo')))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en('set.repairWaiting')))
    fireEvent.change(pass!, { target: { value: 'pw' } })
    expect((screen.getByText(en('set.repairGo')) as HTMLButtonElement).disabled).toBe(false)
  })
  it('each outcome has its own words, and the screen re-reads the record', async () => {
    for (const [state, key] of [['refused', 'set.repairRefused'], ['unavailable', 'set.repairWaiting'], ['notConfirmed', 'set.repairWrong'], ['wrongPassphrase', 'set.repairWrong'], ['unreadable', 'set.repairUnreadable']] as const) {
      cleanup()
      repair.mockResolvedValue({ state })
      const onDone = vi.fn()
      const { container } = render(<I18nProvider><ReceiversRepair rec={rec} onDone={onDone} /></I18nProvider>)
      fireEvent.click(screen.getByText(en('set.repairOpen')))
      const [code, pass] = Array.from(container.querySelectorAll('input'))
      fireEvent.change(code!, { target: { value: 'A' } })
      fireEvent.change(pass!, { target: { value: 'p' } })
      fireEvent.click(screen.getByText(en('set.repairGo')))
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe(en(key)))
      expect(onDone).toHaveBeenCalledTimes(1)
    }
  })
  it('says what a code cannot prove, in both languages', async () => {
    const { pt } = await import('./i18n/pt-BR').then((m) => ({ pt: (m as { ptBR?: Record<string, string> }).ptBR ?? Object.values(m)[0] as Record<string, string> }))
    expect(en('set.repairHow')).toContain('not that the key is good')
    expect(en('set.repairHow')).toContain('is not a reason')
    expect(pt['set.repairHow']).toContain('não que a chave é boa')
    expect(pt['set.repairHow']).toContain('não é motivo')
  })
})

