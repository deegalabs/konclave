// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RecipientCombobox } from './RecipientCombobox'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// Whichever language the provider starts in: the sentence is the same claim in both.
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SENTENCE = new RegExp([en['rec.saplingWarn']!, ptBR['rec.saplingWarn']!].map(esc).join('|'))

/* (#294): in a payroll row the line's own slot carries the blocking Sapling word, so the
 * picker's under-field sentence is skipped there and the member reads it once. Rendered, not
 * grepped: a refactor of the condition must change what shows, not a spelling a scan pins. */

const ZS = 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const mount = (compact: boolean) => render(
  <I18nProvider><RecipientCombobox compact={compact} benefs={[]} address={ZS} name={null} onChange={() => {}} /></I18nProvider>,
)
afterEach(cleanup)

describe('the picker says Sapling once', () => {
  it('under a plain field it says it itself', () => {
    mount(false)
    expect(screen.getByText(SENTENCE)).toBeTruthy()
  })
  it('in a payroll row it leaves the word to the line', () => {
    mount(true)
    expect(screen.queryByText(SENTENCE)).toBeNull()
  })
  it('and carries the row\'s state onto its input', () => {
    cleanup()
    render(<I18nProvider><RecipientCombobox compact invalid describedBy="plr-issue-0" benefs={[]} address={ZS} name={null} onChange={() => {}} /></I18nProvider>)
    const input = screen.getByRole('combobox')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('plr-issue-0')
  })
})
