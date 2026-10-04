/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { codeOf } from './source-scan'

// #610 final review. The signer reads its vault once, when it mounts: the share it opens, the
// signing room it joins, the record the gate reads the vault's own receivers from, the vault the send
// names. Switching vaults from the rail changes the selected vault and navigates, but the signer
// stayed mounted on the vault it had read, while the proposals and approved lines it compared came
// from the newly selected one. Keying the provider by the selected vault gives each vault its own
// signer, so no state can carry from one to the other.
//
// Asserted on the source, as member-names.test does for the same file: exercising Layout's switch
// needs a router, the storage and the coordinator faked hard enough that the test would assert the
// fakes.
describe('one signer per vault', () => {
  const layout = codeOf('./Layout.tsx')

  it('mounts the signer keyed by the selected vault', () => {
    expect(layout).toMatch(/<VaultSignerProvider key=\{getSelectedVault\(\) \?\? ''\}>/)
  })

  it('reads the approved lines from its own vault, not the selection other tabs can change', () => {
    const signer = codeOf('./VaultSigner.tsx')
    expect(signer).toMatch(/getProposalDetail\(active\.id, vault\.id\)/)
  })

  it('the signing panel reads the same vault the signer is on', () => {
    // The panel's balance and payroll reads are display, not the gate, but a second rule for "which
    // vault" is how the first one drifted (#610 third review).
    const panel = codeOf('./screens/SigningPanel.tsx')
    expect(panel).not.toMatch(/getBalance\(\)|getProposalDetail\(active\.id\)/)
    expect(panel).toMatch(/getBalance\(vault\.id\)/)
    expect(panel).toMatch(/getProposalDetail\(active\.id, vault\.id\)/)
  })

  it('the rail follows a switch, so it names the vault the signer is on', () => {
    // Layout read its own vault once, so after A -> B the rail still named A, and switching back to A
    // returned early on the stale id.
    const start = layout.indexOf('function switchTo(')
    const switchTo = layout.slice(start, layout.indexOf('\n  }\n', start))
    expect(switchTo).toMatch(/setSelectedVault\(id\)[\s\S]*getVault\(\)/)
  })
})
