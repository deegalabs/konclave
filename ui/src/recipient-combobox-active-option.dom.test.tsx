// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RecipientCombobox } from './RecipientCombobox'
import { I18nProvider } from './i18n'

// ARIA 1.2 combobox: focus stays in the input, so the highlighted option is named by
// aria-activedescendant. Without it a screen reader never hears which address Enter would pick (#228).
const benefs = [
  { id: 'b1', name: 'Ana', address: 'u1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', memo: '' },
  { id: 'b2', name: 'Bruno', address: 'u1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', memo: '' },
]

describe('RecipientCombobox active option', () => {
  afterEach(() => cleanup())

  it('arrow keys move aria-activedescendant to the highlighted option, and closing clears it', () => {
    localStorage.setItem('konclave.locale', 'en')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<I18nProvider><RecipientCombobox benefs={benefs as any} address="" name={null} onChange={() => {}} /></I18nProvider>)
    const input = screen.getByRole('combobox')
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    fireEvent.focus(input)
    const opts = screen.getAllByRole('option')
    expect(opts.length).toBeGreaterThanOrEqual(2)
    const ids = opts.map((o) => o.id)
    expect(ids.every((i) => i)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const first = input.getAttribute('aria-activedescendant')
    expect(first).toBeTruthy()
    const hiIdx = screen.getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true')
    expect(first).toBe(screen.getAllByRole('option')[hiIdx]?.id)

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    const second = input.getAttribute('aria-activedescendant')
    expect(second).not.toBe(first)
    const hi2 = screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')!
    expect(second).toBe(hi2.id)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
  })
})

describe('two comboboxes on one screen (a payroll has one per row)', () => {
  afterEach(() => cleanup())
  it('share no listbox or option id', () => {
    localStorage.setItem('konclave.locale', 'en')
    render(<I18nProvider><>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RecipientCombobox benefs={benefs as any} address="" name={null} onChange={() => {}} />
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RecipientCombobox benefs={benefs as any} address="" name={null} onChange={() => {}} />
    </></I18nProvider>)
    for (const input of screen.getAllByRole('combobox')) fireEvent.focus(input)
    const ids = [...document.querySelectorAll('[role="listbox"], [role="option"]')].map((e) => e.id)
    expect(ids.length).toBeGreaterThanOrEqual(6)
    expect(ids.every((i) => i)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    const ctl = screen.getAllByRole('combobox').map((i) => i.getAttribute('aria-controls'))
    expect(new Set(ctl).size).toBe(2)
  })
})
