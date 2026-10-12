import { describe, expect, it, vi } from 'vitest'
import { codeAt } from './source-scan'

// The vault's read key must be on the coordinator BEFORE anyone asks it for the viewing key: the
// coordinator refuses the viewing key to a vault with no read key, and the creation's backup asks
// for it right after registering. When the read key was registered without being waited for, the
// backup at creation came out without the viewing key (found on production, 2026-10-12).
const order: string[] = []
let releaseRead: () => void = () => {}
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./signing', () => ({ decodeBundle: () => ({ keyPackage: {}, seat: 1 }) }))
vi.mock('./device-key', () => ({ devicePubHex: () => 'aa', deviceWriteKeyHex: () => 'bb' }))
vi.mock('./vault-secret', () => ({ deriveReadKey: async () => new Uint8Array([1]) }))
vi.mock('./helper', () => ({
  registerReadKey: () => new Promise<boolean>((res) => { releaseRead = () => { order.push('read'); res(true) } }),
  registerDeviceKey: async () => { order.push('device'); return { added: true } },
}))

describe('registering this device', () => {
  it('resolves only once the read key has been registered', async () => {
    const { registerThisDevice } = await import('./device-registration')
    const share = { groupKey: new Uint8Array([2]), accessSecret: new Uint8Array([3]), threshold: 2 } as never
    let done = false
    const p = registerThisDevice('ab'.repeat(32), share).then(() => { done = true })
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    releaseRead()
    await p
    expect(order).toContain('read')
  })

  it('the creation waits for it before it asks for the viewing key', () => {
    const code = codeAt(new URL('./screens/NetVault.tsx', import.meta.url).pathname)
    expect(code).toMatch(/await registerThisDevice\(/)
    expect(code).not.toMatch(/void registerThisDevice\(/)
    expect(code.indexOf('await registerThisDevice(')).toBeLessThan(code.indexOf('getUfvk(saved.vaultId'))
  })
})
