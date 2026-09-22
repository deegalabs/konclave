import { describe, expect, it } from 'vitest'
import { settlementOf, isConfirmed } from './settlement'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The Dashboard rendered a green chip saying **Confirmed** over a transaction still in the mempool.
// It read the proposal's own state - and the proposal cannot know: `HelperProposal::recompute`
// early-returns on `"sent"`, and nothing in the coordinator ever writes `"confirmed"`, so on the
// web path that state is unreachable. The chip was therefore not "sometimes early". It was
// structurally unable to be right.
const SENT = { state: 'sent', txid: 'aa'.repeat(32) }

describe('confirmed means a block, or it is not said', () => {
  it('says confirmed, with the height, when the chain shows one', () => {
    const s = settlementOf(SENT, [{ txid: SENT.txid, mined_height: 3_484_695 }])
    expect(s).toEqual({ kind: 'confirmed', height: 3_484_695 })
    expect(isConfirmed(s)).toBe(true)
  })

  // Each of these is a way the old code would have said "confirmed" anyway, because it never
  // looked at the chain at all.
  const cannotProve: Array<[string, Parameters<typeof settlementOf>[1]]> = [
    ['the transaction list has not loaded', null],
    ['the list does not contain this txid', [{ txid: 'bb'.repeat(32), mined_height: 100 }]],
    ['the wallet has the transaction but no block', [{ txid: 'aa'.repeat(32), mined_height: null }]],
    ['the height is zero, which is not block zero', [{ txid: 'aa'.repeat(32), mined_height: 0 }]],
  ]
  for (const [why, txs] of cannotProve) {
    it(`says broadcast when ${why}`, () => {
      expect(settlementOf(SENT, txs)).toEqual({ kind: 'broadcast' })
    })
  }

  it('says broadcast when the proposal carries no txid', () => {
    expect(settlementOf({ state: 'sent' }, [{ txid: 'aa'.repeat(32), mined_height: 9 }]))
      .toEqual({ kind: 'broadcast' })
  })

  it('never returns confirmed without a height, whatever it is handed', () => {
    // The invariant the whole change rests on, asserted as a property rather than case by case:
    // being slow to call something confirmed costs a member nothing, being early tells them their
    // money arrived when it has not.
    const inputs: Array<Parameters<typeof settlementOf>> = [
      [{ state: 'sent', txid: '' }, null],
      [{ state: 'sent', txid: '  ' }, []],
      [{ state: 'confirmed', txid: 'cc'.repeat(32) }, []],
      [{ state: 'sent', txid: 'aa'.repeat(32) }, [{ txid: 'aa'.repeat(32), mined_height: -1 }]],
    ]
    for (const args of inputs) {
      const s = settlementOf(...args)
      expect(isConfirmed(s), `claimed confirmation from ${JSON.stringify(args[0])}`).toBe(false)
    }
  })

  it('leaves a proposal that was never broadcast alone', () => {
    for (const state of ['awaiting', 'ready', 'refused', 'expired', 'cancelled', 'superseded']) {
      expect(settlementOf({ state, txid: 'aa'.repeat(32) }, [{ txid: 'aa'.repeat(32), mined_height: 9 }]))
        .toEqual({ kind: 'open' })
    }
  })
})

describe('the screens cannot go back to asking the proposal', () => {
  const SRC = new URL('.', import.meta.url).pathname
  const codeOf = (f: string) =>
    readFileSync(join(SRC, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  it('a sent proposal stops polling, because nothing will change it', () => {
    // `HelperProposal::recompute` early-returns on "sent" and nothing writes "confirmed", so the
    // old code asked every 8 seconds, forever, for a transition that cannot happen - at a service
    // with no rate limit. Dropping `sent` from this list restores the forever-poll.
    const code = codeOf('screens/Proposal.tsx')
    const line = code.split('\n').find((l) => l.includes('const terminal'))
    expect(line, 'Proposal.tsx no longer computes a terminal set').toBeTruthy()
    expect(line, "'sent' left the terminal set: the screen polls forever again").toMatch(/'sent'/)
  })

  it('the dashboard derives settlement instead of reading the state', () => {
    const code = codeOf('screens/Dashboard.tsx')
    expect(code, 'the movement row is back to labelling from the proposal state').not.toMatch(
      /\?\s*'confirmado'/,
    )
    expect(code, 'the row no longer derives settlement from the chain').toMatch(/settlementOf\(/)
  })
})
