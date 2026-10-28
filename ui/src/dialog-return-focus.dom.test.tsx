// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Dialog } from './components'

// #667: a dialog that puts focus in a field as it opens (remove, import and unlock a vault; the
// creation dialog; rotate passphrase and export) left focus on the page when it closed. It recorded
// where to return AFTER the field had taken focus, so it recorded the field, gone on close. The
// opener is now read during the first render, before any autofocus.
function Host({ autoFocusField, focusCard }: { autoFocusField: boolean; focusCard?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <main>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Dialog labelledBy="t" onClose={() => setOpen(false)} className="ov" cardClassName="card" focusCard={focusCard}>
          <h2 id="t">Title</h2>
          <input aria-label="word" autoFocus={autoFocusField} />
          <button onClick={() => setOpen(false)}>Close</button>
        </Dialog>
      )}
    </main>
  )
}

const openAndClose = (how: 'button' | 'escape') => {
  const opener = screen.getByRole('button', { name: 'Open' })
  opener.focus()
  fireEvent.click(opener)
  expect(screen.getByRole('dialog')).toBeTruthy()
  if (how === 'button') fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  else fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  return opener
}

describe('closing a dialog returns focus to what opened it (#667)', () => {
  afterEach(cleanup)

  it('when a field inside took focus on open, by the close button and by Escape', () => {
    render(<Host autoFocusField />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus(); fireEvent.click(opener)
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'word' })) // the field did take focus
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(document.activeElement).toBe(opener)

    expect(openAndClose('escape')).toBe(document.activeElement)
  })

  it('when nothing inside autofocused, and when the dialog opened on its card', () => {
    render(<Host autoFocusField={false} />)
    expect(openAndClose('button')).toBe(document.activeElement)
    cleanup()
    render(<Host autoFocusField focusCard />)
    expect(openAndClose('button')).toBe(document.activeElement)
  })
})
