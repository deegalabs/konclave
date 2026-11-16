// @vitest-environment jsdom
// The create/join dialog on /vaults is the embedded Shell of NetVault. The notice has to be in what
// that dialog renders, not just somewhere in the file.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import NetVault from './screens/NetVault'

afterEach(cleanup)

describe('the embedded create/join dialog', () => {
  it('renders the host notice, once, with the id the dialog points at', () => {
    localStorage.setItem('konclave.locale', 'en')
    const { container } = render(
      <MemoryRouter><I18nProvider><NetVault embedded onLeave={() => {}} /></I18nProvider></MemoryRouter>,
    )
    const n = container.querySelectorAll('#host-notice')
    expect(n.length).toBe(1)
    expect(n[0]!.textContent).toContain('Konclave only lives at www.konclave.xyz.')
    expect(container.querySelector('.net-embedded #host-notice')).not.toBeNull()
  })
})
