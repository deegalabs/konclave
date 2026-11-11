// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #821. A registration the coordinator REFUSES leaves the seat with no device on record: a payment
// cannot be sealed to it and its votes cannot be checked, so this device cannot sign or vote. It
// used to go to the console only. These pin that a refusal reaches the screen, that a coordinator
// which did not answer does not raise it, and that a registration that lands clears it.
const answer = vi.hoisted(() => ({ added: null as boolean | null, failure: null as { status: number; error?: string; code?: string } | null }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./signing', () => ({ decodeBundle: () => ({ keyPackage: {}, seat: 2 }) }))
vi.mock('./device-key', () => ({ devicePubHex: () => 'aa', deviceWriteKeyHex: () => 'bb' }))
vi.mock('./vault-secret', () => ({ deriveReadKey: async () => new Uint8Array([1]) }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ seatCertificateFromBundle: () => 'cert' }))
vi.mock('./helper', () => ({
  registerReadKeyResult: async () => ({ ok: true }),
  registerDeviceKeyResult: async () => (answer.added === null ? { failure: answer.failure } : { ok: answer.added }),
}))

const { registerThisDevice } = await import('./device-registration')
const { seatRefusal, useSeatRefusal } = await import('./seat-registration')
const { deviceRefusal } = await import('./session')

const V = 'ab'.repeat(32)
const share = { groupKey: new Uint8Array([2]) } as never
const register = async (added: boolean | null, failure: { status: number; error?: string } | null) => {
  answer.added = added
  answer.failure = failure
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return registerThisDevice(V, share)
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('a refused seat registration is shown, not only logged', () => {
  it('protocol 3: a refusal with the coordinator\'s code is recorded where the signer reads it', async () => {
    answer.added = null
    answer.failure = { status: 409, error: 'x', code: 'a_code' }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const cp3 = { groupKey: new Uint8Array([2]), cp: 3, accessSecret: new Uint8Array(32) } as never
    expect(await registerThisDevice(V, cp3)).toEqual({ refused: 'a_code' })
    expect(deviceRefusal(V)).toBe('a_code')
    expect(await register(true, null)).toBe(true)
    expect(deviceRefusal(V)).toBeUndefined()
  })

  it('a seat held by another device has its own words', async () => {
    expect(await register(null, { status: 409, error: 'this seat is already registered to another device' })).toBe(false)
    expect(seatRefusal(V)).toBe('registration.seatTaken')
  })

  it('any other refusal says the server did not register this device', async () => {
    await register(null, { status: 400, error: 'seat is outside this vault’s seats' })
    expect(seatRefusal(V)).toBe('registration.seatRefused')
  })

  it('a registration that lands clears it', async () => {
    await register(null, { status: 409, error: 'x' })
    expect(await register(true, null)).toBe(true)
    expect(seatRefusal(V)).toBeNull()
  })

  it('a coordinator that did not answer, or failed on its side, is not a refusal', async () => {
    for (const failure of [null, { status: 503, error: 'busy' }, { status: 500 }]) {
      await register(true, null)
      await register(null, failure)
      expect(seatRefusal(V), JSON.stringify(failure)).toBeNull()
    }
  })

  it('the banner follows the registration as it changes', async () => {
    function Banner() {
      const k = useSeatRefusal(V)
      return <div>{k ? en[k] : 'none'}</div>
    }
    await register(true, null)
    render(<Banner />)
    expect(screen.getByText('none')).toBeTruthy()
    await act(async () => { await register(null, { status: 409, error: 'already registered to another device' }) })
    expect(screen.getByText(en['registration.seatTaken']!)).toBeTruthy()
  })

  it('the Dashboard shows it for the selected vault', () => {
    const dash = codeOf('screens/Dashboard.tsx')
    expect(dash).toMatch(/const seatRefused = useSeatRefusal\(getSelectedVault\(\)\)/)
    expect(dash).toMatch(/\{seatRefused && <BannerWarn>\{t\(seatRefused\)\}<\/BannerWarn>\}/)
  })

  it('in both languages, naming what the member cannot do', () => {
    for (const k of ['registration.seatTaken', 'registration.seatRefused']) {
      expect(en[k], k).toMatch(/sign payments or vote/)
      expect(ptBR[k], k).toMatch(/assinar pagamentos nem votar/)
      for (const s of [en[k]!, ptBR[k]!]) expect(s).not.toMatch(/coordinator|coordenador|FROST|share/i)
    }
  })
})
