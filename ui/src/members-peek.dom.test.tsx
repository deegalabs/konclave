// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import MembersPeek from './MembersPeek'

// #602: the roster popover off "N members" could not be closed with Escape, because it was CSS
// alone. It is now a state: hover and focus open it, mouse leave, blur and Escape close it.

const roster = [{ name: 'Alice', pubkey: 'a' }, { name: 'Bob', pubkey: 'b' }]
const mount = () => render(<MemoryRouter><I18nProvider><MembersPeek members={2} thr={2} n={2} roster={roster} creator="Alice" me="Bob" /></I18nProvider></MemoryRouter>)
const peek = () => document.querySelector('.members-peek') as HTMLElement
const link = () => screen.getByRole('link')
afterEach(cleanup)

describe('the members popover (#602)', () => {
  it('opens on keyboard focus and closes on Escape, without moving focus', () => {
    mount()
    expect(peek().className).not.toContain('open')
    fireEvent.focus(link())
    expect(peek().className).toContain('open')
    expect(link().getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(peek().className).not.toContain('open')
    expect(link().getAttribute('aria-expanded')).toBe('false')
  })

  it('opens on hover and closes when the pointer leaves or focus moves away', () => {
    mount()
    fireEvent.mouseEnter(peek())
    expect(peek().className).toContain('open')
    fireEvent.mouseLeave(peek())
    expect(peek().className).not.toContain('open')
    fireEvent.focus(link())
    fireEvent.blur(link())
    expect(peek().className).not.toContain('open')
  })

  it('lists the roster with the creator and you marked, and the quorum', () => {
    mount()
    expect(screen.getByText('Alice')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(document.getElementById('members-pop')!.textContent).toContain('2')
  })
})
