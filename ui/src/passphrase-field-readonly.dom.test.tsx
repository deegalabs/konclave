// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { PassphraseField, VaultPassForm } from './components'
import { I18nProvider } from './i18n'

// #928: a locked passphrase field cannot be written to: no typing, and no generator that would
// replace what is being sealed. The meter is read-only and stays.
afterEach(cleanup)
const noop = () => {}
// A passphrase field sits in a VaultPassForm (#929), as every screen renders it.
const show = (el: React.ReactElement) => render(<I18nProvider><VaultPassForm vault={null}>{el}</VaultPassForm></I18nProvider>)

describe('PassphraseField readOnly (#928)', () => {
  it('is read-only, offers no generator, and keeps the meter', () => {
    const { container } = show(<PassphraseField label="Passphrase" value="correct horse battery staple" onChange={noop} readOnly />)
    expect((container.querySelector('input') as HTMLInputElement).readOnly).toBe(true)
    expect(container.querySelector('.pf-gen')).toBeNull()
    expect(container.querySelector('.pf-meter')).not.toBeNull()
  })
  it('by default is unchanged: editable, with the generator (Settings, the first field)', () => {
    const { container } = show(<PassphraseField label="Passphrase" value="correct horse battery staple" onChange={noop} />)
    expect((container.querySelector('input') as HTMLInputElement).readOnly).toBe(false)
    expect(container.querySelector('.pf-gen')).not.toBeNull()
  })
})
