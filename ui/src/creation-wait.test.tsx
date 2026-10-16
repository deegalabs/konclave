import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WaitLine, saveWaitText } from './screens/CeremonyParts'
import { codeOf } from './source-scan'

// Daniel (16/10, staging run): after the first member protected their part, the creation screen
// showed "Saved on this device" and one line of plain text while the others had not saved yet, and
// it looked frozen. A wait that depends on other people shows that it is waiting, and that it moves.
const en = (_pt: string, e: string) => e
const pt = (p: string) => p

describe('creating a vault: waiting on the others shows that it is waiting', () => {
  it('while busy, the status line carries a spinner beside its sentence', () => {
    expect(renderToStaticMarkup(<WaitLine busy>1 of 3 saved. Waiting for: ana, bia.</WaitLine>)).toBe(
      '<p class="cv-seatlabel cv-wait" role="status"><span class="loader-ring sm" aria-hidden="true"></span><span>1 of 3 saved. Waiting for: ana, bia.</span></p>',
    )
  })

  it('when idle, the status region is still there, empty, and has no spinner', () => {
    expect(renderToStaticMarkup(<WaitLine busy={false}>{''}</WaitLine>)).toBe(
      '<p class="cv-seatlabel cv-wait" role="status"><span></span></p>',
    )
  })

  it('says how many have saved and who is left, so the wait moves without motion', () => {
    expect(saveWaitText(3, ['ana', 'bia'], en)).toBe('1 of 3 saved. Waiting for: ana, bia.')
    expect(saveWaitText(3, ['bia'], en)).toBe('2 of 3 saved. Waiting for: bia.')
    expect(saveWaitText(3, ['ana', 'bia'], pt)).toBe('1 de 3 guardaram. Esperando: ana, bia.')
  })

  it('the save step keeps one status line mounted and fills it, on both creation screens', () => {
    const src = codeOf('./screens/NetVault.tsx')
    expect(src).toMatch(/<WaitLine busy=\{!!saveWait\}>\{saveWait\}<\/WaitLine>/)
    expect(src).toMatch(/waiting\.length > 0 \? saveWaitText\(total, waiting, pe\)/)
    expect(src).toMatch(/<WaitLine busy=\{!finished && waiting\.length > 0\}>/)
    // No third wording of the same wait.
    expect(src).not.toMatch(/Waiting for the others to save/)
  })

  it('follows the app’s one reduced-motion rule for the ring, and long names wrap', () => {
    const css = codeOf('./net.css')
    expect(css).not.toMatch(/\.cv-wait \.loader-ring \{[^}]*animation/)
    expect(codeOf('./App.css')).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\.loader-ring\{animation-duration:2\.4s\}\}/)
    expect(css).toMatch(/\.cv-wait > span \{ min-width: 0; overflow-wrap: anywhere; \}/)
  })
})
