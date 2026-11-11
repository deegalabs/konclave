import { describe, expect, it, vi } from 'vitest'

// At protocol 3 a read key the coordinator refuses with a code ends the registration with that code.
// The helper mock offers no failure slot at all: reading one would throw, so the code can only come
// from the refused call's own answer.
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./signing', () => ({ decodeBundle: () => ({ keyPackage: {}, seat: 2 }) }))
vi.mock('./device-key', () => ({ devicePubHex: () => 'aa', deviceWriteKeyHex: () => 'bb' }))
vi.mock('./vault-secret', () => ({ deriveReadKey: async () => new Uint8Array([1]) }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ seatCertificateFromBundle: () => 'cert' }))
const sent = vi.hoisted(() => ({ device: vi.fn(async () => ({ ok: true })) }))
vi.mock('./helper', () => ({
  registerReadKeyResult: async () => ({ failure: { status: 409, error: 'x', code: 'read_key_pinned' } }),
  registerDeviceKeyResult: sent.device,
}))

describe('a refused read key at protocol 3', () => {
  it('is carried up with the coordinator\'s code, and the seat is not registered after it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { registerThisDevice } = await import('./device-registration')
    const share = { groupKey: new Uint8Array([2]), cp: 3, threshold: 2, accessSecret: new Uint8Array(32) } as never
    expect(await registerThisDevice('ab'.repeat(32), share)).toEqual({ refused: 'read_key_pinned' })
    expect(sent.device).not.toHaveBeenCalled()
  })
})
