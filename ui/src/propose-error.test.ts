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

  // #568. The coordinator refuses a write whose name is not the seat that signed it. The vote
  // showed that as "this vote no longer applies" and the payroll as "unrecognized address",
  // which told a member with a real problem to go and look at something else.
  it('a write under a name that is not the seat says so, in all three wordings', () => {
    for (const sentence of [
      'you can only vote for your own seat',
      'you can only propose under your own name',
      'you can only rename your own seat',
    ]) expect(humanError(t, sentence), sentence).toBe('error.notYourSeat')
  })

  // The other 403 a vote can get, and the one a name with stray whitespace used to meet first:
  // the roster check runs before the seat is even looked at.
  it('a name the roster does not hold says that, not "conflicting vote"', () => {
    expect(humanError(t, 'not a member of this vault')).toBe('error.notAMember')
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

  // The third caller. #509 fixed the vote, the fix above fixed the payment, and the payroll went
  // on calling every failure a bad address - a refused seat included (#568).
  it('createPayroll reads the recorded failure too', () => {
    const fn = CODE.split('export async function createPayroll')[1]?.split('\nexport ')[0] ?? ''
    expect(fn, 'createPayroll not found').toBeTruthy()
    expect(fn, 'it must read what actually failed').toContain('lastHelperPostFailure')
    expect(
      /error:\s*'invalid address'/.test(fn.split('try {')[0] ?? ''),
      'createPayroll is asserting "invalid address", whatever went wrong',
    ).toBe(false)
  })

  // The rename was the one write the app never signed. The coordinator has required a signed
  // rename since #454, so on every vault with signed actions turned on, renaming answered 401 and
  // the member was told only that it failed.
  it('a rename is signed like every other write', () => {
    const fn = CODE.split('export async function renameSelf')[1]?.split('\nexport ')[0] ?? ''
    expect(fn, 'renameSelf not found').toBeTruthy()
    // The target has to be the pair the coordinator verifies, `old\0new`, built from the SAME two
    // strings that go in the body. The first version of this test looked for the word `proof`,
    // which the parameter's own name satisfied: it passed with the proof dropped from the body.
    expect(fn, 'the rename goes out with no proof, or signs something else')
      .toContain("writeProof(id, 'rename', `${old}\\u0000${next}`)")
    expect(fn, 'the proof must be handed to the call that sends').toMatch(/netRenameMember\(id, old, next, await writeProof/)
    const helper = readFileSync(join(new URL('.', import.meta.url).pathname, 'helper.ts'), 'utf8')
    const send = helper.split('export async function renameMember')[1]?.split('\nexport ')[0] ?? ''
    expect(send, 'and the helper client must SPREAD it into the body').toContain('...(proof ?? {})')
    expect(send, 'beside the same old and new it signed').toContain('old, new: next')
  })

  it('the Members screen shows a refused rename through the same translation as everything else', () => {
    const screen = readFileSync(join(new URL('.', import.meta.url).pathname, 'screens', 'Members.tsx'), 'utf8')
    expect(screen, 'it prints the coordinator\'s raw English').toContain('humanError(t, renameErr)')
  })

  it('a refused vote passes the coordinator\'s reason on instead of calling it a conflict', () => {
    const fn = CODE.split('export async function voteProposal')[1]?.split('\nexport ')[0] ?? ''
    expect(fn, 'voteProposal not found').toBeTruthy()
    expect(fn, 'a 403 carries a reason and it must reach the member').toContain('403')
  })
})
