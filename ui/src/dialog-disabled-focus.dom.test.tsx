// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Dialog } from './components'

// A control that is disabled while it holds focus (a button pressed to start something) keeps
// document.activeElement in some browsers; it is not in the trap's list, so Tab used to run the
// browser default and leave the dialog. The trap treats it as focus that escaped.
afterEach(cleanup)
const Box = ({ busy }: { busy: boolean }) => (
  <Dialog labelledBy="t" onClose={() => {}} className="unlock-overlay" cardClassName="unlock-card">
    <h2 id="t">Title</h2>
    <button id="a">A</button>
    <button id="b" disabled={busy}>B</button>
  </Dialog>
)

describe('Dialog focus trap', () => {
  it('Tab from a just-disabled button comes back to the first control', () => {
    const { rerender } = render(<Box busy={false} />)
    const b = document.getElementById('b') as HTMLButtonElement
    b.focus()
    expect(document.activeElement).toBe(b)
    rerender(<Box busy />)
    expect(document.activeElement).toBe(b) // jsdom keeps it, as some browsers do
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('a'))
  })
  it('Tab from the last enabled control still wraps, and from the middle is left alone', () => {
    render(<Box busy={false} />)
    ;(document.getElementById('b') as HTMLElement).focus()
    const wrap = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(wrap)
    expect(document.activeElement).toBe(document.getElementById('a'))
    const mid = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(mid)
    expect(mid.defaultPrevented).toBe(false)
  })
})
