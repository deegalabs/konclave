import { expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'
const h = vi.hoisted(() => ({ meta: vi.fn(async () => {}), clear: vi.fn() }))
vi.mock('./storage', () => ({ updateVaultMeta: h.meta }))
vi.mock('./session', () => ({ clearUnlockedShare: h.clear }))
const { stopCreation } = await import('./stop-creation')

it('a stopped creation is marked, and its share leaves the session even if the mark fails', async () => {
  await stopCreation('v', 'secret')
  expect(h.meta).toHaveBeenCalledWith('v', { abandoned: 'secret' })
  h.meta.mockRejectedValueOnce(new Error('x'))
  await stopCreation('v', 'secret')
  expect(h.clear).toHaveBeenCalledTimes(2)
})
it('the share leaves first: a write that hangs does not keep it', () => {
  h.clear.mockClear()
  h.meta.mockReturnValueOnce(new Promise(() => {}))
  void stopCreation('v', 'secret')
  expect(h.clear).toHaveBeenCalledTimes(1)
})
it('both stops in the creation go through it', () => {
  expect(codeOf('./screens/NetVault.tsx').match(/stopCreation\(/g)).toHaveLength(2)
  expect(codeOf('./screens/NetVault.tsx')).not.toMatch(/abandoned:/)
})
