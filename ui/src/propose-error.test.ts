import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { humanError } from './api'

// Found on a live vault on 2026-09-17: a proposal was refused and the member was told "Unrecognized
// destination address. Check the Zcash address." The address was a saved beneficiary, rendered
// correctly in the draft panel two lines below the error.
//
// `netCreateProposal` returns `Proposal | null`, and the caller turned EVERY null into
// `invalid address` - a locked device, an unaffordable amount, a restarting coordinator, all of it.
// On a money screen a wrong reason is worse than no reason: it sends someone to fix something that
// is not broken and hides the thing that is. Neither the member nor the maintainer could tell what
// had actually failed, which is how this went undiagnosed.
//
// It is the SAME defect #509 fixed for the vote, in the other caller, and the machinery #509 built
// to stop it was already there and simply unused.
const t = (k: string) => k

describe('a refused proposal says what the coordinator actually refused (#509, other caller)', () => {
  // The coordinator's real wordings, copied from `orchestrator/src/helper.rs` and
  // `orchestrator/src/address.rs`. These are what it sends, not what the client hoped for.
  it('a malformed address is named as one', () => {
    expect(humanError(t, 'this is not a valid Zcash address')).toBe('error.invalidAddress')
  })

  it('a testnet address gets its own sentence, not "unrecognized"', () => {
    // The address is perfectly valid. Telling someone to check it teaches them nothing.
    expect(humanError(t, 'this is a testnet address, not mainnet')).toBe('error.wrongNetwork')
  })

  it('an address that cannot hold Orchard is not called unrecognized either', () => {
    expect(humanError(t, 'this address cannot receive shielded Orchard funds')).toBe('error.notOrchard')
  })

  it('a payment that would cross both pools says so', () => {
    // #525, live since 2026-09-17. Before this mapping it would have read as a bad address.
    expect(humanError(t, 'crosses shielded pools')).toBe('error.crossesPools')
  })

  it('a device that cannot prove its seat is not an address problem', () => {
    expect(humanError(t, 'write not authorized')).toBe('error.writeNotAuthorized')
  })

  it('and a refusal with no reason says THAT, rather than inventing one', () => {
    expect(humanError(t, 'proposal rejected')).toBe('error.proposalRejected')
  })
})

describe('no caller invents a reason the coordinator did not give', () => {
  // The guard, because the fix is "use what #509 built" and nothing stops the next caller from
  // inventing again. `postJson` collapses failures to null by design - that is what makes inventing
  // so easy, and why it has now happened twice.
  const SRC = readFileSync(join(new URL('.', import.meta.url).pathname, 'api.ts'), 'utf8')
  const CODE = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  it('createProposal reads the recorded failure instead of asserting a cause', () => {
    const fn = CODE.split('export async function createProposal')[1]?.split('\nexport ')[0] ?? ''
    expect(fn, 'createProposal not found').toBeTruthy()
    expect(fn, 'it must read what actually failed').toContain('lastHelperPostFailure')
    expect(
      /error:\s*'invalid address'/.test(fn),
      'createProposal is asserting "invalid address" again, whatever went wrong',
    ).toBe(false)
  })
})
