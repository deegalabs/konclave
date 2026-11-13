import { beforeEach, describe, expect, it, vi } from 'vitest'

// Each seat tells the coordinator which network fees its build accepts (`fee_from`, from the wasm's
// era table). A wasm without the export sends no field: the coordinator reads that as "reports nothing".
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./signing', () => ({ decodeBundle: () => ({ keyPackage: {}, seat: 2 }) }))
vi.mock('./device-key', () => ({ devicePubHex: () => 'aa', deviceWriteKeyHex: () => 'bb' }))
vi.mock('./vault-secret', () => ({ deriveReadKey: async () => new Uint8Array([1]) }))
const wasm = vi.hoisted(() => ({ feeFrom: undefined as undefined | (() => number | undefined) }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({
  seatCertificateFromBundle: () => 'cert',
  get feeFrom() { return wasm.feeFrom },
}))
const sent = vi.hoisted(() => ({ device: vi.fn(async (..._a: unknown[]) => ({ ok: true })) }))
vi.mock('./helper', () => ({
  registerReadKeyResult: async () => ({ ok: true }),
  registerDeviceKeyResult: sent.device,
}))

const share = { groupKey: new Uint8Array([2]), cp: 2, threshold: 2 } as never
beforeEach(() => { sent.device.mockClear(); wasm.feeFrom = undefined })

describe('the registration carries fee_from', () => {
  it('sends the height the wasm reports', async () => {
    wasm.feeFrom = () => 3_590_000
    const { registerThisDevice } = await import('./device-registration')
    expect(await registerThisDevice('ab'.repeat(32), share)).toBe(true)
    expect(sent.device.mock.calls[0]?.[4]).toBe(3_590_000)
  })

  it('omits it when the wasm has no such export (an older one)', async () => {
    const { registerThisDevice } = await import('./device-registration')
    expect(await registerThisDevice('ab'.repeat(32), share)).toBe(true)
    expect(sent.device.mock.calls[0]?.[4]).toBeUndefined()
  })

  it('omits it when the export answers nothing usable', async () => {
    const { registerThisDevice } = await import('./device-registration')
    for (const bad of [undefined, -1, 1.5, Number.NaN]) {
      sent.device.mockClear()
      wasm.feeFrom = () => bad
      await registerThisDevice('ab'.repeat(32), share)
      expect(sent.device.mock.calls[0]?.[4]).toBeUndefined()
    }
  })
})
