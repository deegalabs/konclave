import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// #659: a vault's id opens its metadata to whoever holds it (the coordinator answers /api/vault by
// id), so the /net page does not print it whole by default: on a call, a screen share or over a
// shoulder it would travel. It shows the short fingerprint members compare, or the id's ends.
describe('the /net page prints no whole vault id (#659)', () => {
  it('renders the fingerprint or a shortened id, never the id itself', () => {
    const src = codeOf('screens/NetVault.tsx')
    expect(src).not.toMatch(/>\s*\{\s*(groupVk|v\.id)\s*\}/)
    // Every vault-key line shows the fingerprint and nothing else (no fallback to the id).
    const vk = [...src.matchAll(/<div className="net-vk">([^<]*)<\/div>/g)].map((m) => m[1])
    const fpLines = vk.filter((c) => c === "{fp ?? '…'}")
    expect(fpLines).toHaveLength(3)
    for (const c of vk) expect(c, c).not.toMatch(/groupVk/)
    expect(src).toMatch(/\{shortAddr\(v\.id, 6, 4\)\}/)
  })
})
