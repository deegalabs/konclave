import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// /net's own signing driver keeps no record of what it signed and checks no approval. Where a
// coordinator is configured, a proposal is signed from its signing panel (VaultSigner), which does;
// so /net refuses to execute one there and points to the panel. Without a coordinator /net shows no
// proposals at all (its panel renders only with one), and its other parts stay until #627.
describe('/net does not execute a proposal where a coordinator is configured', () => {
  const src = codeOf('./screens/NetVault.tsx')
  it('the page has no way to execute a proposal: it never calls executeProposal', () => {
    expect(src).not.toMatch(/\bexecuteProposal\b/)
  })
  it('its signer contributes to no coordinator request: the claim refuses, so no share leaves', () => {
    expect(src).toMatch(/claim: \(\) => false,/)
    expect(src).not.toMatch(/claim: \(\) => true/)
  })
  it('the proposal row offers the signing panel, not a Sign & send button', () => {
    expect(src).not.toMatch(/'Sign & send'/)
    expect(src).toMatch(/nav\('\/proposal', \{ state: \{ id: p\.id \} \}\)/)
  })
  it('a coordinator request is consumed before the signer sees it', () => {
    expect(src).toMatch(/if \(parseSignRequest\(reqData\)\) return true/)
    expect(src).not.toMatch(/tryHelperRequest/)
  })
})
