import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WaitLine } from './screens/CeremonyParts'
import { codeOf } from './source-scan'

// Daniel (16/10, staging run): after the first member protected their part, the creation screen
// showed "Saved on this device" and one line of plain text while the others had not saved yet, and
// it looked frozen. A wait that depends on other people shows that it is waiting.
describe('creating a vault: waiting on the others shows that it is waiting', () => {
  it('a wait line carries a spinner beside its text, announced once', () => {
    const html = renderToStaticMarkup(<WaitLine>Waiting for the others to save: dan.</WaitLine>)
    expect(html).toBe(
      '<p class="cv-seatlabel cv-wait" role="status"><span class="loader-ring sm" aria-hidden="true"></span><span>Waiting for the others to save: dan.</span></p>',
    )
  })

  it('the save step uses it while others have not saved, and while the vault registers', () => {
    const src = codeOf('./screens/NetVault.tsx')
    expect(src).toMatch(/saveState === 'saved' && waiting\.length > 0 && \(\s*<WaitLine>\{pe\(`Esperando os outros guardarem/)
    expect(src).toMatch(/hostedState === 'registering' && \(\s*<WaitLine>\{pe\('Registrando o cofre…'/)
  })

  it('stops turning under reduced motion', () => {
    const css = codeOf('./net.css')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.cv-wait \.loader-ring \{ animation: none; \} \}/)
  })
})
