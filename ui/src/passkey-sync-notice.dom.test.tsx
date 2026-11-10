// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from './i18n'
import { ToastProvider } from './toast'
import { en as dict } from './i18n/en'
import { ptBR } from './i18n/pt-BR'
const en = (k: string): string => dict[k] ?? k

// Decided by the maintainer on 2026-11-06. Turning the passkey shortcut on from Settings, with a
// passkey that may sync: the member is told that the shortcut still works only on this device, that
// a sync may stop it working here too, and that the passphrase stays the way in. Enrolment is never
// blocked. Mounted for real; only the enrolment ceremony, the session secret and the vault's reads
// are fakes. `backupEligible` is what `enrolPrf` read from the authenticator data's bytes
// (webauthn-flags.test.ts covers that half).
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

describe('the synced-passkey notice', () => {
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

  // The notice already says the shortcut works only on this device and the passphrase stays the way
  // in, which is the whole of the access note: the note shows only when the notice does not.
  it('with the notice, the access note is not repeated under it', async () => {
    enrol.backupEligible = true
    await turnOn()
    expect(screen.queryByText(en('set.accessNote'))).toBeNull()
  })

  it('without the notice, the access note is there', async () => {
    enrol.backupEligible = false
    await turnOn()
    expect(screen.getByText(en('set.accessNote'))).toBeTruthy()
  })

  it('removing the passkey clears the notice', async () => {
    enrol.backupEligible = true
    await turnOn()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en('set.passkeyOff') })) })
    expect(screen.queryByText(en('settings.passkeySynced'))).toBeNull()
    expect(screen.getByText(en('set.accessNote'))).toBeTruthy()
  })
})

describe('the synced-passkey copy', () => {
  // A synced passkey does not carry the shortcut to another device: the wrap lives on this device
  // alone. The first version of this sentence said a synced passkey "may stop opening the shortcut
  // on another device", which reads as if it could open it there. Both languages must say the
  // shortcut stays on this device.
  it('en says the shortcut works only on this device, and the passphrase stays the way in', () => {
    expect(dict['settings.passkeySynced']).toContain('only on this device')
    expect(dict['settings.passkeySynced']).toContain('passphrase')
    expect(dict['settings.passkeySynced']).not.toMatch(/another device/)
  })

  it('pt-BR says the same: s\u00f3 neste aparelho', () => {
    expect(ptBR['settings.passkeySynced']).toContain('s\u00f3 neste aparelho')
    expect(ptBR['settings.passkeySynced']).toContain('frase-senha')
    expect(ptBR['settings.passkeySynced']).not.toMatch(/outro aparelho/)
  })
})
