// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PassphraseField } from './components'
import { I18nProvider } from './i18n'

// A passphrase field names itself: a visible label tied to the input by the component, so the name
// does not depend on the caller and stays after typing (a placeholder does not).
afterEach(cleanup)
const noop = () => {}
const show = (el: React.ReactElement) => render(<I18nProvider>{el}</I18nProvider>)

// Type-level: leaving the label out must not compile. Only `tsc -b` checks this (never run).
export function omitsTheLabel() {
  // @ts-expect-error label is required
  return <PassphraseField value="" onChange={noop} />
}

describe('PassphraseField label', () => {
  it('is the accessible name of the input, and stays once there is a value', () => {
    show(<PassphraseField label="Current passphrase" value="" onChange={noop} />)
    expect((screen.getByLabelText('Current passphrase') as HTMLInputElement).tagName).toBe('INPUT')
    cleanup()
    show(<PassphraseField label="Current passphrase" value="correct horse battery staple" onChange={noop} />)
    expect(screen.getByLabelText('Current passphrase')).toBeTruthy()
    expect(screen.getByText('Current passphrase').tagName).toBe('LABEL')
  })
  it('two fields in one tree have distinct ids and each its own label', () => {
    show(<><PassphraseField label="First" value="" onChange={noop} /><PassphraseField label="Second" value="" onChange={noop} /></>)
    const a = screen.getByLabelText('First'); const b = screen.getByLabelText('Second')
    expect(a.id).toBeTruthy(); expect(b.id).toBeTruthy(); expect(a.id).not.toBe(b.id)
  })
  it('uses the id the caller gives', () => {
    show(<PassphraseField label="X" id="mine" value="" onChange={noop} />)
    expect(screen.getByLabelText('X').id).toBe('mine')
  })
  it('styles the label with pf-caption by default and labelClassName when given', () => {
    show(<><PassphraseField label="A" value="" onChange={noop} /><PassphraseField label="B" labelClassName="cv-k" value="" onChange={noop} /></>)
    expect(screen.getByText('A').className).toBe('pf-caption')
    expect(screen.getByText('B').className).toBe('cv-k')
  })
})
