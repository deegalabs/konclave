import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// A refused vote must not be reported as a conflict.
//
// `netVote` returns `Proposal | null`, and the caller turned every null into `'vote rejected'`,
// which the dictionary renders as "the proposal already changed state, or there is a conflicting
// vote". A sentence about consensus, shown for a 401 - a device that simply could not prove it holds
// the seat, because it is locked or never registered a write key for its seat.
//
// This was found live, on a real vault, while its owner was testing an approval: the screen told him
// there was a conflicting vote, and there was no conflict. On a money screen a wrong reason is worse
// than no reason, because it sends someone looking for something that does not exist.
//
// It also got worse the day #288 gated proposing and sending, which made 401 far more reachable. A
// stricter gate and a lying error message are a bad pair.

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

describe('a refused write is not reported as a vote conflict', () => {
  it('the vote path distinguishes 401 from every other failure', () => {
    // Structural: the block must consult the helper's status before falling back.
    const vote = api.slice(api.indexOf('const p = await netVote('))
    const block = vote.slice(0, vote.indexOf('\n  }'))
    expect(block).toContain('lastHelperPostFailure()')
    expect(block).toContain('401')
    expect(block).toContain('write not authorized')
  })

  it('both errors have their own message, and they say different things', () => {
    for (const lang of ['pt-BR', 'en']) {
      const dict = readFileSync(new URL(`./i18n/${lang}.ts`, import.meta.url), 'utf8')
      const auth = /'error\.writeNotAuthorized':\s*'([^']+)'/.exec(dict)?.[1]
      const rejected = /'error\.voteRejected':\s*'([^']+)'/.exec(dict)?.[1]
      expect(auth, `${lang} has no writeNotAuthorized`).toBeTruthy()
      expect(rejected, `${lang} has no voteRejected`).toBeTruthy()
      expect(auth).not.toBe(rejected)
      // The whole point: the authorization message must not blame the proposal's state.
      expect(auth!.toLowerCase()).not.toMatch(/conflit|estado|state/)
    }
  })

  it('humanError maps the new code, and before the old one', () => {
    const i = api.indexOf("e === 'write not authorized'")
    const j = api.indexOf("e === 'vote rejected'")
    expect(i, 'write not authorized is not mapped').toBeGreaterThan(-1)
    expect(i).toBeLessThan(j)
  })
})
