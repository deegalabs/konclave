/// <reference types="node" />
// The provider half of the #610 refusal wording, which the panel tests reach only through a mocked
// `useVaultSigner`. The provider used to keep its own flag of whether the gate's last refusal was
// "could not load what was approved", set from the decision, and only the harmless direction of that
// mapping had a test (#610 third review: `decision !== 'match'` passed the whole suite and would have
// worded a real mismatch as "reload"). The machine now words each answer itself, tested both ways in
// signing-machine.test.ts, so what is left here is that the provider hands the gate's answer through
// untouched and names nothing as change before it knows the vault's receivers.
//
// Server rendering runs no effects, so this reaches the state BEFORE the approval loads; the
// pass-through itself is pinned on the source, as signer-per-vault.test.ts does for this file.
import { describe, expect, it, vi } from 'vitest'
import { codeOf } from './source-scan'
import { renderToStaticMarkup } from 'react-dom/server'

const captured: { decide?: (o: unknown[]) => string } = {}
vi.mock('./useBackgroundSigner', () => ({
  useBackgroundSigner: (_u: unknown, _g: unknown, decide: (o: unknown[]) => string) => {
    captured.decide = decide
    return { ready: false, phase: 'idle', error: '', what: null, setProposal: () => {}, unarm: async () => {} }
  },
}))
vi.mock('./api', () => ({ getVault: async () => null, getProposalDetail: async () => null, isVaultUnlocked: () => false, IS_NET: true }))
vi.mock('./storage', () => ({ listVaults: async () => [] }))
vi.mock('./wasm-ready', () => ({ ensureWasm: async () => {} }))
vi.mock('./wasm-pkg/konclave_wasm.js', () => ({ uaReceiver: () => '' }))

const { VaultSignerProvider, useVaultSigner } = await import('./VaultSigner')
import type { useBackgroundSigner } from './useBackgroundSigner'

describe('the provider hands the gate its answer (#610)', () => {
  it('before the approval loads the answer is unknown, and nothing is called change', () => {
    let ctx: ReturnType<typeof useVaultSigner> | null = null
    function Probe() {
      ctx = useVaultSigner()
      return null
    }
    renderToStaticMarkup(<VaultSignerProvider><Probe /></VaultSignerProvider>)
    expect(captured.decide).toBeTypeOf('function')
    expect(captured.decide!([{ value: 1, recipient: 'aa', address: null, memo: '' }])).toBe('unknown')
    expect(ctx!.isOurReceiver('8dfd0a5e')).toBe(false)
  })

  it('passes the gate decision through untouched, so no second rule words a refusal', () => {
    const src = codeOf('./VaultSigner.tsx')
    expect(src).toMatch(/\(outputs: PcztOutput\[\]\): GateDecision => gateDecision\(approvalRef\.current, outputs\),/)
    expect(src).toMatch(/useBackgroundSigner\(unlocked, gate, decideApproval\)/) // and hands it on as is
    expect(src).toMatch(/isOurReceiver: \(recipient\) => paysOurselves\(recipient, ourReceiversRef\.current\),/)
  })

  // The hops this test cannot run: the hook hands the decision to the session (whose own test runs
  // both refusals), and the lab, which has no proposal, answers `unknown`. A wrapper at either one
  // turned the money gate off with every test green (#610 fifth review).
  it('the hook hands the decision to the session as is, and the lab never answers match', () => {
    expect(codeOf('./useBackgroundSigner.ts')).toMatch(/new BackgroundSession\(\{\s*decideApproval,\s/)
    expect(codeOf('./screens/BackgroundSignerLab.tsx')).toMatch(/useBackgroundSigner\(unlocked, gate, \(\) => 'unknown'\)/)
  })
})

// The hook takes the money gate with no default, so a caller that leaves it out does not compile.
type HookArgs = Parameters<typeof useBackgroundSigner>
// @ts-expect-error the money gate is required
export const twoArgs: HookArgs = [null, () => false]
