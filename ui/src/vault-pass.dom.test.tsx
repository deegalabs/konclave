// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Dialog, PassphraseField, VaultPassForm, VaultPassInput } from './components'
import { I18nProvider } from './i18n'
import { vaultUsername } from './vault-username'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const username = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[autocomplete="username"]')

describe('a passphrase form (#929)', () => {
  afterEach(cleanup)

  it('puts the hidden username first, outside any label, readOnly and out of the tab order', async () => {
    const { container } = render(
      <VaultPassForm vault={{ name: 'Treasury', id: A }}>
        <label className="field"><span>Passphrase</span><VaultPassInput autoComplete="current-password" /></label>
      </VaultPassForm>)
    await waitFor(() => expect(username(container)).not.toBeNull())
    const u = username(container)!
    expect(u.value).toBe('Treasury · 62e6')
    expect(u.closest('form')!.firstElementChild).toBe(u)
    expect(u.closest('label')).toBeNull()
    expect(u.readOnly).toBe(true)
    expect(u.tabIndex).toBe(-1)
    expect(u.getAttribute('aria-hidden')).toBe('true')
    expect(u.className).toContain('visually-hidden')
    // The label still names the real field, not the hidden one.
    expect(screen.getByLabelText('Passphrase').getAttribute('type')).toBe('password')
  })

  it('gives two vaults two usernames, and the same text again for the same record', async () => {
    const one = render(<VaultPassForm vault={{ name: 'Treasury', id: A }}><VaultPassInput autoComplete="current-password" /></VaultPassForm>)
    const two = render(<VaultPassForm vault={{ name: 'Treasury', id: B }}><VaultPassInput autoComplete="current-password" /></VaultPassForm>)
    await waitFor(() => expect(username(one.container)).not.toBeNull())
    await waitFor(() => expect(username(two.container)).not.toBeNull())
    expect(username(one.container)!.value).not.toBe(username(two.container)!.value)
    // What the create screen renders and what the unlock screen later renders for the record.
    expect(username(one.container)!.value).toBe(await vaultUsername('Treasury', A))
  })

  it('has no username for a field with no vault to name, and does not leak the id', async () => {
    const { container } = render(<VaultPassForm vault={null}><VaultPassInput autoComplete="current-password" /></VaultPassForm>)
    await new Promise((r) => setTimeout(r, 20))
    expect(username(container)).toBeNull()
    const named = render(<VaultPassForm vault={{ name: 'T', id: A }}><VaultPassInput autoComplete="new-password" /></VaultPassForm>)
    await waitFor(() => expect(username(named.container)).not.toBeNull())
    expect(named.container.innerHTML).not.toContain(A.slice(0, 8))
  })

  it('says whether the passphrase is chosen or entered', () => {
    const { container } = render(
      <I18nProvider><VaultPassForm vault={null}>
        <VaultPassInput autoComplete="current-password" />
        <PassphraseField label="New" value="" onChange={() => {}} autoComplete="new-password" />
      </VaultPassForm></I18nProvider>)
    const [cur, fresh] = Array.from(container.querySelectorAll('input[type="password"]'))
    expect(cur?.getAttribute('autocomplete')).toBe('current-password')
    expect(fresh?.getAttribute('autocomplete')).toBe('new-password')
  })

  it('always cancels the submit (an uncancelled one reloads the page) and runs the action', () => {
    const onSubmit = vi.fn()
    const { container } = render(<VaultPassForm vault={null} onSubmit={onSubmit}><VaultPassInput autoComplete="current-password" /><button type="submit">go</button></VaultPassForm>)
    const form = container.querySelector('form')!
    const ev = new Event('submit', { bubbles: true, cancelable: true })
    form.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const bare = render(<VaultPassForm vault={null}><VaultPassInput autoComplete="current-password" /></VaultPassForm>)
    const ev2 = new Event('submit', { bubbles: true, cancelable: true })
    bare.container.querySelector('form')!.dispatchEvent(ev2)
    expect(ev2.defaultPrevented).toBe(true)
  })

  it('refuses a passphrase input outside a form', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<VaultPassInput autoComplete="current-password" />)).toThrow(/VaultPassForm/)
    log.mockRestore()
  })

  it('hides a revealed passphrase again when the form is used', () => {
    const { container } = render(
      <I18nProvider><VaultPassForm vault={null}>
        <PassphraseField label="Current" value="x" onChange={() => {}} autoComplete="current-password" choosing={false} />
        <button type="button">act</button>
      </VaultPassForm></I18nProvider>)
    const input = () => container.querySelector('.pf-input') as HTMLInputElement
    fireEvent.click(container.querySelector('.pf-btn')!)
    expect(input().type).toBe('text')
    fireEvent.click(screen.getByText('act'))
    expect(input().type).toBe('password')
  })
})

describe('Dialog focus with the hidden username inside (#929, B2)', () => {
  afterEach(cleanup)

  function Open() {
    return (
      <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="t" onClose={() => {}}>
        <h2 id="t">title</h2>
        <VaultPassForm vault={{ name: 'Treasury', id: A }}>
          <VaultPassInput autoComplete="current-password" aria-label="pass" />
          <button type="button">first</button>
          <button type="button">last</button>
        </VaultPassForm>
      </Dialog>)
  }

  it('opens on the real field, not on a tabindex=-1 input that is already there', () => {
    // The username lands after an async digest, so a test through the form would decide the focus
    // before it exists. This is the same shape with the input present at mount.
    render(
      <Dialog className="unlock-overlay" cardClassName="unlock-card" labelledBy="t" onClose={() => {}}>
        <h2 id="t">title</h2>
        <input type="text" autoComplete="username" readOnly tabIndex={-1} aria-hidden="true" defaultValue="x" />
        <input type="password" aria-label="pass" />
      </Dialog>)
    expect(document.activeElement).toBe(screen.getByLabelText('pass'))
  })

  it('Shift+Tab from the first control wraps to the last, not out of the dialog', async () => {
    const { container } = render(<Open />)
    await waitFor(() => expect(username(container)).not.toBeNull())
    const pass = screen.getByLabelText('pass')
    pass.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('last'))
  })
})
