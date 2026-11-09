// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FundsLine, SpendBars } from './charts'
import { I18nProvider } from './i18n'

// A native tooltip never shows on focus or touch, so the figures of a chart are offered by a
// button that shows the table: it says whether it is open, and the table it opens is the one a
// screen reader already reads.
const mount = (el: React.ReactElement, locale = 'en') => {
  localStorage.setItem('konclave.locale', locale)
  return render(<I18nProvider>{el}</I18nProvider>)
}

afterEach(cleanup)

describe('Show figures', () => {
  it('shows the funds table and says so, then hides it again', () => {
    mount(
      <FundsLine
        now={{ label: 'nov', zat: 300_000_000 }}
        ahead={[{ label: 'dez', zat: 200_000_000 }]}
        nowLabel="Now"
        projectedLabel="Projected"
        title="Free funds"
        source="From the vault's book."
        tooShort="Not enough history."
        runsOut={null}
      />,
    )
    const btn = screen.getByRole('button', { name: 'Show figures' })
    const figs = document.getElementById(btn.getAttribute('aria-controls')!)!
    expect(figs.className).toBe('visually-hidden')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(btn.textContent).toBe('Hide figures')
    expect(figs.className).toBe('chart-figs')
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(figs.className).toBe('visually-hidden')
  })

  it('shows the spend table the same way', () => {
    mount(<SpendBars data={[{ label: 'set', zec: 1 }, { label: 'out', zec: 2 }]} />)
    const btn = screen.getByRole('button', { name: 'Show figures' })
    fireEvent.click(btn)
    expect(document.getElementById(btn.getAttribute('aria-controls')!)!.className).toBe('chart-figs')
  })

  // The caption is visible once the table is shown, so it is in the screen's language, and the
  // group is named the same way as the Dashboard panel it sits in.
  it('names the spend table and its group in the screen language', () => {
    mount(<SpendBars data={[{ label: 'set', zec: 1 }, { label: 'out', zec: 2 }]} />, 'pt-BR')
    expect(document.querySelector('.spend caption')!.textContent).toBe('Gastos por mês')
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Gastos por mês (ZEC)')
  })
})
