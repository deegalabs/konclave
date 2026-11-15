import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// #659: a vault's id opens its metadata to whoever holds it (the coordinator answers /api/vault by
// id), so no screen prints it whole by default: on a call, a screen share or over a shoulder it
// would travel. The /net page shows the short fingerprint members compare, or the id's ends.
describe('no screen prints a whole vault id (#659)', () => {
  it('the /net page renders the fingerprint or a shortened id, never the id itself', () => {
    const src = codeOf('screens/NetVault.tsx')
    expect(src).not.toMatch(/>\{(groupVk|v\.id)\}</)
    expect(src).toMatch(/<div className="net-vk">\{fp \?\? '…'\}<\/div>/)
    expect(src).toMatch(/\{shortAddr\(v\.id, 6, 4\)\}/)
  })
})
