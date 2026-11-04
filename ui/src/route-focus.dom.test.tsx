// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { RouteFocus } from './route-focus'

// #662: on a route change, focus moves to the new screen's main heading and the tab says where
// the member is; not on the first load, and not while a dialog is open.

function Home() {
  return <main><h1>Home</h1><Link to="/ledger">Book</Link><Link to="/late">Late</Link><Link to="/modal">Modal</Link></main>
}
function Ledger() {
  return <main><h1>Book</h1><Link to="/">Home</Link></main>
}
// A screen that draws its heading only after a first read, as the dashboard does.
function Late() {
  const [ready, setReady] = useState(false)
  useEffect(() => { const t = setTimeout(() => setReady(true), 50); return () => clearTimeout(t) }, [])
  return <main>{ready ? <h1>Late heading</h1> : <p>Loading</p>}</main>
}
function Modal() {
  return <main><h1>Behind</h1><div role="dialog" aria-modal="true"><button>In the dialog</button></div></main>
}
const app = (at: string) => render(
  <MemoryRouter initialEntries={[at]}>
    <RouteFocus />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/ledger" element={<Ledger />} />
      <Route path="/late" element={<Late />} />
      <Route path="/modal" element={<Modal />} />
    </Routes>
  </MemoryRouter>,
)
afterEach(() => { cleanup(); document.title = '' })

describe('focus follows the route (#662)', () => {
  it('leaves the first load alone', () => {
    app('/')
    expect(document.activeElement).toBe(document.body)
    expect(document.title).toBe('')
  })

  it('moves focus to the new heading and names the tab after it', async () => {
    app('/')
    fireEvent.click(screen.getByText('Book'))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Book'))
    expect(document.activeElement?.tagName).toBe('H1')
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1')
    expect(document.title).toBe('Book · Konclave')
  })

  it('waits for a heading the screen draws after its first read', async () => {
    app('/')
    fireEvent.click(screen.getByText('Late'))
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Late heading'))
  })

  it('does not take focus from an open dialog', async () => {
    app('/')
    fireEvent.click(screen.getByText('Modal'))
    await screen.findByText('In the dialog')
    await new Promise((r) => setTimeout(r, 30))
    expect(document.activeElement?.tagName).not.toBe('H1')
    expect(document.title).toBe('')
  })
})
