// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { noteSeatRefused, noteSeatRegistered, useSeatRefusal, useSeatRefusalCode } from './seat-registration'
import { codeOf } from './source-scan'

// A registration runs after an unlock without being awaited, so its refusal lands AFTER the screen
// rendered. Both readers subscribe to the one store, so the words appear at once.
const V = 'ef'.repeat(32)
function Probe() {
  const code = useSeatRefusalCode(V)
  const banner = useSeatRefusal(V)
  return <p>code={code ?? '-'} banner={banner ?? '-'}</p>
}
afterEach(() => { cleanup(); noteSeatRegistered(V) })

describe('the refused-seat hooks follow the store after the first render', () => {
  it('a coded refusal that lands later reaches the shell, not the banner', () => {
    render(<Probe />)
    expect(screen.getByText('code=- banner=-')).toBeTruthy()
    act(() => noteSeatRefused(V, 'registration.seatRefused', 'a_code'))
    expect(screen.getByText('code=a_code banner=-')).toBeTruthy()
  })
  it('an uncoded refusal that lands later reaches the banner', () => {
    render(<Probe />)
    act(() => noteSeatRefused(V, 'registration.seatTaken'))
    expect(screen.getByText('code=- banner=registration.seatTaken')).toBeTruthy()
  })
  it('the shell reads the live hook, not a value taken at render', () => {
    const layout = codeOf('Layout.tsx')
    expect(layout).toMatch(/const refusedCode = useSeatRefusalCode\(getSelectedVault\(\)\)/)
    expect(layout).not.toMatch(/deviceRefusal\(/)
    // A code this app does not know is not an empty alert: it falls back to "the seat was refused".
    expect(layout).toMatch(/const knownCode = coordinatorCode\(refusedCode\)/)
    expect(layout).toMatch(/knownCode \? refusalKey\(\{ refused: 'coded', code: knownCode \}\) : 'registration\.seatRefused'/)
  })
})
