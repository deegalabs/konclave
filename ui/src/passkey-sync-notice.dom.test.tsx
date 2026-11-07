// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
const en = (k: string): string => dict[k] ?? k

// D95. Turning the passkey shortcut on from Settings, with a passkey that may sync: the member is
// told that a synced passkey may stop opening the shortcut on other devices or after a sync, and
// that the passphrase stays the way in. Enrolment is never blocked. Mounted for real; only the
// enrolment ceremony, the session secret and the vault's reads are fakes. `backupEligible` is what
// `enrolPrf` read from the authenticator data's bytes (webauthn-flags.test.ts covers that half).
const enrol = vi.hoisted(() => ({ backupEligible: null as boolean | null }))
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  health: async () => true,
  getVault: async () => ({ id: 'v', name: 'Treasury', threshold: 2, total: 2, member_list: [] }),
  getSelectedVault: () => 'v',
}))
vi.mock('./storage', async (orig) => ({
  ...(await orig<typeof import('./storage')>()),
  listVaults: async () => [{ id: 'v', name: 'Treasury', governance: 'quorum', myName: 'Ana', groupKey: 'ab'.repeat(32), roster: ['Ana', 'Bia'], secured: true }],
}))
vi.mock('./session', async (orig) => ({
  ...(await orig<typeof import('./session')>()),
  readSecretFor: () => new Uint8Array(32).fill(9),
}))
vi.mock('./prf-wrap', async (orig) => ({
  ...(await orig<typeof import('./prf-wrap')>()),
  enrolPrf: async () => ({ credentialId: 'AQID', salt: 'aa'.repeat(32), iv: 'bb'.repeat(12), cipher: 'cc'.repeat(48), backupEligible: enrol.backupEligible }),
}))
const { default: Settings } = await import('./screens/Settings')

async function turnOn() {
  render(<MemoryRouter><I18nProvider><ToastProvider><Settings /></ToastProvider></I18nProvider></MemoryRouter>)
  const btn = await screen.findByRole('button', { name: en('set.passkeyOn') })
  await act(async () => { fireEvent.click(btn) })
  // Enrolment went through in every case: the control now offers to remove it.
  expect(await screen.findByRole('button', { name: en('set.passkeyOff') })).toBeTruthy()
}

describe('the synced-passkey notice (D95)', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('konclave.locale', 'en')
    Object.defineProperty(navigator, 'credentials', { value: { create: vi.fn(), get: vi.fn() }, configurable: true })
  })
  afterEach(() => cleanup())

  it('BE set: the notice appears, and enrolment is not blocked', async () => {
    enrol.backupEligible = true
    await turnOn()
    expect(screen.getByText(en('settings.passkeySynced'))).toBeTruthy()
  })

  it('BE clear: no notice', async () => {
    enrol.backupEligible = false
    await turnOn()
    expect(screen.queryByText(en('settings.passkeySynced'))).toBeNull()
  })

  it('BE unknown (nothing readable): no notice, rather than a guess', async () => {
    enrol.backupEligible = null
    await turnOn()
    expect(screen.queryByText(en('settings.passkeySynced'))).toBeNull()
  })

  it('removing the passkey clears the notice', async () => {
    enrol.backupEligible = true
    await turnOn()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('set.passkeyOff') })) })
    expect(screen.queryByText(en('settings.passkeySynced'))).toBeNull()
  })
})
