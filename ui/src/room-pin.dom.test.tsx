// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { codeOf } from './source-scan'
import { InviteCard } from './screens/CeremonyParts'

vi.setConfig({ testTimeout: 30_000 })
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))

const { default: NetVault } = await import('./screens/NetVault')

afterEach(() => cleanup())

// The creator's step 2 shows the PIN the app made, so the button works without typing; a new one
// is one press away, and a PIN of the member's own is the exception under the same minimum.
function openStep2() {
  render(<MemoryRouter><I18nProvider><NetVault embedded /></I18nProvider></MemoryRouter>)
  fireEvent.change(screen.getByLabelText(/your name/i), { target: { value: 'Alice' } })
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))
}
const shown = () => screen.getByLabelText('Room PIN', { selector: 'output' }).querySelector('[aria-hidden]')!.textContent ?? ''

describe('creating a vault: the PIN the app makes', () => {
  it('shows 13 digits in groups, and the button is enabled without typing', () => {
    openStep2()
    expect(shown()).toMatch(/^\d{4} \d{4} \d{4} \d$/)
    expect((screen.getByRole('button', { name: /generate invite/i }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('textbox', { name: /room pin/i })).toBeNull()
    // A screen reader hears the digits one by one, in groups.
    expect(screen.getByLabelText('Room PIN', { selector: 'output' }).textContent).toMatch(/(\d \d \d \d, ){2}\d \d \d \d, \d$/)
  })

  it('"New PIN" changes it', () => {
    openStep2()
    const first = shown()
    fireEvent.click(screen.getByRole('button', { name: /new pin/i }))
    expect(shown()).not.toBe(first)
    expect(shown()).toMatch(/^\d{4} \d{4} \d{4} \d$/)
  })

  it('"Use my own PIN" shows an empty field and the button follows the minimum and the check', () => {
    openStep2()
    fireEvent.click(screen.getByRole('button', { name: /choose my own pin instead/i }))
    const input = screen.getByLabelText('Room PIN', { selector: 'input' }) as HTMLInputElement
    const go = screen.getByRole('button', { name: /generate invite/i }) as HTMLButtonElement
    expect(input.value).toBe('')
    expect(go.disabled).toBe(true)
    fireEvent.change(input, { target: { value: '12345' } })
    expect(go.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'blue heron' } })
    expect(go.disabled).toBe(false)
    // 13 digits whose last digit does not check the others: refused, and it says so.
    fireEvent.change(input, { target: { value: '1234 5678 9012 4' } })
    expect(go.disabled).toBe(true)
    expect(screen.getByText(/A PIN of 13 digits must end in its check digit/)).toBeTruthy()
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(input, { target: { value: '1234-5678-9012-3' } })
    expect(go.disabled).toBe(true)
    expect(screen.getByText(/Type only the digits of the PIN/)).toBeTruthy()
  })

  it('announces a new PIN through a status that is empty until then, and moves focus with the toggle', () => {
    openStep2()
    const status = () => screen.getAllByRole('status').find((e) => e.classList.contains('sr-only'))!
    expect(status().textContent).toBe('')
    fireEvent.click(screen.getByRole('button', { name: /new pin/i }))
    expect(status().textContent).toMatch(/^New PIN: \d/)
    fireEvent.click(screen.getByRole('button', { name: /choose my own pin instead/i }))
    expect(document.activeElement).toBe(screen.getByLabelText('Room PIN', { selector: 'input' }))
    fireEvent.click(screen.getByRole('button', { name: /use the pin the app made/i }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /new pin/i }))
  })

  it('draws a new PIN each time the rule step opens', () => {
    openStep2()
    const first = shown()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(shown()).not.toBe(first)
  })
})

describe('both creation screens offer the same made PIN', () => {
  it('the create step and the lab card both show it and begin with the chosen one', () => {
    const src = codeOf('./screens/NetVault.tsx')
    expect(src.match(/<MadePin /g)?.length).toBe(2)
    expect(src.match(/begin\('create', newInviteCode\(\), n, t, createPin\)/g)?.length).toBe(2)
    expect(src).not.toMatch(/begin\('create', newInviteCode\(\), n, t, pin\)/)
  })
})

// The join forms hold their button closed for a 13-digit PIN whose last digit does not check the
// others, and say so on the field. Removing the check from either button turns these red.
describe('joining: a 13-digit PIN with a wrong check digit', () => {
  const CODE = '0123456789ABCDEFGHJKMNPQRS'
  const BAD = '1234 5678 9012 4'

  it('main form: Join stays disabled, the field is marked and says why', () => {
    render(<MemoryRouter><I18nProvider><NetVault embedded initialJoin /></I18nProvider></MemoryRouter>)
    fireEvent.change(document.getElementById('cv-join-name')!, { target: { value: 'Bia' } })
    fireEvent.change(document.getElementById('cv-join-invite')!, { target: { value: CODE } })
    const pin = document.getElementById('cv-join-pin') as HTMLInputElement
    const join = screen.getByRole('button', { name: /join the vault/i }) as HTMLButtonElement
    fireEvent.change(pin, { target: { value: '1234 5678 9012 3' } })
    expect(join.disabled).toBe(false)
    expect(pin.getAttribute('aria-invalid')).toBeNull()
    fireEvent.change(pin, { target: { value: BAD } })
    expect(join.disabled).toBe(true)
    expect(pin.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('cv-join-pin-err')!.textContent).toBe('Error: Check the PIN: a digit looks wrong.')
    expect(pin.getAttribute('aria-describedby')).toContain('cv-join-pin-err')
  })

  it('main form: a PIN of digits near 13 long says its length and does not block', () => {
    render(<MemoryRouter><I18nProvider><NetVault embedded initialJoin /></I18nProvider></MemoryRouter>)
    fireEvent.change(document.getElementById('cv-join-name')!, { target: { value: 'Bia' } })
    fireEvent.change(document.getElementById('cv-join-invite')!, { target: { value: CODE } })
    fireEvent.change(document.getElementById('cv-join-pin')!, { target: { value: '1234 5678 9012' } })
    expect(document.getElementById('cv-join-pin-note')!.textContent).toBe('This PIN has 12 digits. The one the app makes has 13: check you heard them all.')
    expect((screen.getByRole('button', { name: /join the vault/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('the /net lab: Join with the code stays disabled and says why', () => {
    render(<MemoryRouter><I18nProvider><NetVault /></I18nProvider></MemoryRouter>)
    fireEvent.change(screen.getByPlaceholderText('paste the link or the code'), { target: { value: CODE } })
    const pin = screen.getAllByLabelText('Room PIN', { selector: 'input' })[0] as HTMLInputElement
    const join = screen.getByRole('button', { name: /join with the code/i }) as HTMLButtonElement
    fireEvent.change(pin, { target: { value: '1234 5678 9012 3' } })
    expect(join.disabled).toBe(false)
    fireEvent.change(pin, { target: { value: BAD } })
    expect(join.disabled).toBe(true)
    expect(document.getElementById('net-join-pin-err')!.textContent).toBe('Error: Check the PIN: a digit looks wrong.')
  })

  it('the /net lab: the create card shows the made PIN under the name "Room PIN"', () => {
    render(<MemoryRouter><I18nProvider><NetVault /></I18nProvider></MemoryRouter>)
    expect(document.getElementById('net-create-pin-made')!.getAttribute('aria-labelledby')).toBe('net-create-pin-label')
    expect(screen.queryByText(/Admission PIN/)).toBeNull()
    expect((screen.getByRole('button', { name: /generate invite/i }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('the PIN fields: errors and the own PIN', () => {
  const GOOD = '1234 5678 9012 3'
  const BAD = '1234 5678 9012 4'
  const enPe = (_pt: string, e: string) => e

  it('the error lines are in the page, as status regions, before there is anything to say', () => {
    render(<MemoryRouter><I18nProvider><NetVault embedded initialJoin /></I18nProvider></MemoryRouter>)
    const err = document.getElementById('cv-join-pin-err')!
    expect(err.getAttribute('role')).toBe('status')
    expect(err.textContent).toBe('')
    cleanup()
    render(<MemoryRouter><I18nProvider><NetVault /></I18nProvider></MemoryRouter>)
    for (const id of ['net-join-pin-err']) {
      expect(document.getElementById(id)!.getAttribute('role')).toBe('status')
      expect(document.getElementById(id)!.textContent).toBe('')
    }
    fireEvent.click(screen.getByRole('button', { name: /choose my own pin instead/i }))
    expect(document.getElementById('net-create-pin-err')!.getAttribute('role')).toBe('status')
    expect(document.getElementById('net-create-pin-err')!.textContent).toBe('')
  })

  it('the create step has its error line as a status region too, and the own-PIN field points at it', () => {
    openStep2()
    expect(document.getElementById('cv-create-pin-err')!.getAttribute('role')).toBe('status')
    fireEvent.click(screen.getByRole('button', { name: /choose my own pin instead/i }))
    const input = screen.getByLabelText('Room PIN', { selector: 'input' })
    expect(input.getAttribute('aria-describedby')).toContain('cv-create-pin-err')
  })

  it('/net: both PIN fields are marked invalid by the check, and only then', () => {
    render(<MemoryRouter><I18nProvider><NetVault /></I18nProvider></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: /choose my own pin instead/i }))
    const [create, join] = screen.getAllByLabelText('Room PIN', { selector: 'input' }) as HTMLInputElement[]
    for (const f of [create!, join!]) {
      fireEvent.change(f, { target: { value: GOOD } })
      expect(f.getAttribute('aria-invalid')).toBeNull()
      fireEvent.change(f, { target: { value: BAD } })
      expect(f.getAttribute('aria-invalid')).toBe('true')
    }
  })

  it('the own PIN is kept when the member goes back to the made one and returns', () => {
    openStep2()
    fireEvent.click(screen.getByRole('button', { name: /choose my own pin instead/i }))
    fireEvent.change(screen.getByLabelText('Room PIN', { selector: 'input' }), { target: { value: 'blue heron' } })
    fireEvent.click(screen.getByRole('button', { name: /use the pin the app made/i }))
    fireEvent.click(screen.getByRole('button', { name: /choose my own pin instead/i }))
    expect((screen.getByLabelText('Room PIN', { selector: 'input' }) as HTMLInputElement).value).toBe('blue heron')
  })

  it('the invite card shows the digits on "show" and announces them apart from the visible lines', () => {
    render(<InviteCard code="0123456789ABCDEFGHJKMNPQRS" pin="1234567890123" pe={enPe} />)
    const note = () => Array.from(document.querySelectorAll('[role="status"].sr-only'))[0]!
    expect(note().textContent).toBe('')
    expect(document.body.textContent).not.toMatch(/1234 5678 9012 3/)
    fireEvent.click(screen.getByRole('button', { name: /show/i }))
    expect(document.querySelector('.cv-pin-value [aria-hidden]')!.textContent).toBe('1234 5678 9012 3')
    expect(note().textContent).toBe('Room PIN: 1 2 3 4, 5 6 7 8, 9 0 1 2, 3')
    expect(document.querySelector('.cv-status')!.textContent).toBe('')
  })
})

describe('the PIN styles', () => {
  const css = codeOf('./net.css')
  it('the spoken form is not selectable, so a copy by selection holds only the digits', () => {
    expect(css).toMatch(/\.cv-pin-value \.sr-only \{ user-select: none; -webkit-user-select: none; \}/)
  })
  it('an empty error line stays in the page, and the made PIN scales to fit a narrow card', () => {
    expect(css).not.toMatch(/\.cv-err:empty \{ display: none/)
    expect(css).toMatch(/\.cv-pin-value\.lg \{[^}]*font-size: clamp\(/)
    expect(css).toMatch(/\.cv-pin-value\.lg \{[^}]*white-space: nowrap/)
  })
})
