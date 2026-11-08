// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { en } from './i18n/en'

// The tabs under Approvals follow the keyboard pattern of a tab list: one Tab stop on the selected
// tab, the arrows move between tabs (wrapping), Home and End go to the ends, and the panel is named
// by the tab that shows it. The tabs' contents are stubbed: this is about the tab list alone.
vi.mock('./screens/Proposals', () => ({ default: () => <p>proposals body</p> }))
vi.mock('./screens/Ceremonies', () => ({ default: () => <p>evidence body</p> }))
vi.mock('./screens/SinceLast', () => ({ default: () => <p>since body</p> }))

const { default: Activity } = await import('./screens/Activity')

const mount = () => {
  localStorage.setItem('konclave.locale', 'en')
  return render(<MemoryRouter><I18nProvider><Activity /></I18nProvider></MemoryRouter>)
}
const tab = (k: string) => screen.getByRole('tab', { name: en[`activity.tab.${k}`] })
const selected = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.id)

describe('the Approvals tabs and the keyboard', () => {
  afterEach(() => { cleanup(); localStorage.clear() })

  it('has one Tab stop, on the selected tab, and the panel is named by it', () => {
    mount()
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([0, -1, -1])
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('act-tab-proposals')
    expect(tab('proposals').getAttribute('aria-controls')).toBe('act-panel')
  })

  it('moves with the arrows, wrapping, and with Home and End, taking the focus along', () => {
    mount()
    tab('proposals').focus()
    fireEvent.keyDown(tab('proposals'), { key: 'ArrowRight' })
    expect(selected()).toEqual(['act-tab-since'])
    expect(document.activeElement).toBe(tab('since'))
    expect(screen.getByText('since body')).toBeTruthy()
    fireEvent.keyDown(tab('since'), { key: 'End' })
    expect(selected()).toEqual(['act-tab-evidence'])
    fireEvent.keyDown(tab('evidence'), { key: 'ArrowRight' })
    expect(selected()).toEqual(['act-tab-proposals'])
    fireEvent.keyDown(tab('proposals'), { key: 'ArrowLeft' })
    expect(selected()).toEqual(['act-tab-evidence'])
    fireEvent.keyDown(tab('evidence'), { key: 'Home' })
    expect(selected()).toEqual(['act-tab-proposals'])
    expect(screen.getAllByRole('tab').map((t) => t.tabIndex)).toEqual([0, -1, -1])
  })
})
