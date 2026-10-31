// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RecipientCombobox } from './RecipientCombobox'
import { I18nProvider } from './i18n'

/* (#294): an address the vault cannot pay is said by the screen that refuses it - the payroll
 * line's own slot, the payment field - so the picker says nothing under it, and the member reads
 * the sentence once. Rendered, not grepped: a refactor of the condition must change what shows,
 * not a spelling a scan pins. */

const ZS = 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const mount = (compact: boolean) => render(
  <I18nProvider><RecipientCombobox compact={compact} benefs={[]} address={ZS} name={null} onChange={() => {}} /></I18nProvider>,
)
afterEach(cleanup)

describe('the picker leaves a refused address to the screen', () => {
  const note = () => document.querySelector('.rcb .hint')
  it('under a plain field it says nothing about a Sapling address', () => {
    mount(false)
    expect(note()).toBeNull()
  })
  it('in a payroll row it leaves the word to the line', () => {
    mount(true)
    expect(note()).toBeNull()
  })
  it('and carries the row\'s state onto its input', () => {
    cleanup()
    render(<I18nProvider><RecipientCombobox compact invalid describedBy="plr-issue-0" benefs={[]} address={ZS} name={null} onChange={() => {}} /></I18nProvider>)
    const input = screen.getByRole('combobox')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('plr-issue-0')
  })
})
