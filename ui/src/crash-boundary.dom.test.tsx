// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'
import { ptBR as dict } from './i18n/pt-BR'
const ptBR = (k: string): string => dict[k] ?? k

// #318 review: the crash screen was tested on its own, never through the boundary that shows it.
// This mounts the real boundary around a child that throws during render, in a simulated browser,
// and reads what a member would see.
function Broken(): never {
  throw new Error('render failed on purpose')
}

describe('the error boundary shows the crash screen for a child that throws (#318)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

  it("in the member's saved language, announced, with the two ways out", () => {
    localStorage.setItem('konclave.locale', 'pt-BR')
    // React logs the caught error; the boundary logs it too (locally, never sent). Keep the run quiet.
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Broken /></ErrorBoundary>)
    const alert = screen.getByRole('alert')
    expect(alert.tagName).toBe('MAIN')
    expect(alert.getAttribute('lang')).toBe('pt-BR')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ptBR('crash.title'))
    expect(screen.getByRole('button', { name: ptBR('crash.reload') })).toBeTruthy()
    expect(screen.getByRole('link', { name: ptBR('crash.vaults') }).getAttribute('href')).toBe('#/vaults')
    expect(log).toHaveBeenCalled()
  })

  it('renders the child untouched when nothing throws', () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>)
    expect(screen.getByText('fine')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
