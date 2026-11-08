import { expect, it, vi } from 'vitest'
const digest = vi.hoisted(() => vi.fn(() => 'dd'))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./signing', () => ({ decodeBundle: () => ({ pubkeys: 'pkp' }) }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ pkpDigestHex: digest }))
const { ownPkpDigest } = await import('./pin-digest')

it('the digest covers this device\'s own package, with threshold and total in that order', async () => {
  expect(await ownPkpDigest({} as never, 2, 3)).toBe('dd')
  expect(digest).toHaveBeenCalledWith('pkp', 2, 3)
})
