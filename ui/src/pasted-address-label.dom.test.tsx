// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RecipientCombobox, pastedLabelKey } from './RecipientCombobox'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// A pasted zs1 address was named "Transparent address" ("Endereço transparente") beside its own
// "older shielded" chip: the row had a name for unified and one for everything else.
const ZS = 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'

describe('what a pasted address is called', () => {
  afterEach(() => cleanup())

  it('each kind that reaches the row has its own name, in both languages', () => {
    expect(pastedLabelKey('unified')).toBe('rec.addrShielded')
    expect(pastedLabelKey('sapling')).toBe('rec.addrSapling')
    expect(pastedLabelKey('transparent')).toBe('rec.addrPublic')
    expect(en['rec.addrSapling']).toBe('Older shielded address')
    expect(ptBR['rec.addrSapling']).toBe('Endereço blindado antigo')
  })

  it('a pasted zs1 reads as an older shielded address, never as transparent', () => {
    localStorage.setItem('konclave.locale', 'en')
    render(<I18nProvider><RecipientCombobox benefs={[]} address="" name={null} onChange={() => {}} /></I18nProvider>)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: ZS } })
    const row = screen.getByRole('option')
    expect(row.textContent).toContain(en['rec.addrSapling'])
    expect(row.textContent).not.toContain(en['rec.addrPublic'])
  })
})
