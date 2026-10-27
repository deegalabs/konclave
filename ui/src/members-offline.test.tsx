import { describe, expect, it } from 'vitest'
import { membersView } from './screens/Members'
import { codeOf } from './source-scan'
import { en } from './i18n/en'
import { ptBR } from './i18n/pt-BR'

// #315: with the coordinator offline the screen drew an empty roster under "0 members", with no
// message and no retry, and every seat it did draw carried a role chip it never checked.
describe('the Members screen says when the list was not read (#315)', () => {
  it('one rule decides what is shown', () => {
    const v = { id: 'v', threshold: 2, total: 3, member_list: [] } as never
    expect(membersView(null, null)).toBe('loading')
    expect(membersView(false, null)).toBe('unread') // the coordinator did not answer
    expect(membersView(true, null)).toBe('unread') // it answered, without a vault
    expect(membersView(true, v)).toBe('roster')
  })

  it('the screen renders the three states from that rule, with a retry, and the role chip only inside the roster', () => {
    const src = codeOf('./screens/Members.tsx')
    expect(src).toMatch(/const view = membersView\(live, vault\)/)
    expect(src).toMatch(/view === 'unread' && \([\s\S]*role="alert"[\s\S]*onClick=\{retry\}/)
    const rosterAt = src.indexOf("view === 'roster' && (")
    expect(rosterAt).toBeGreaterThan(0)
    expect(src.indexOf('members.roleShareVote')).toBeGreaterThan(rosterAt)
    // The footer never says "0 members" for a list that was not read.
    expect(src).toMatch(/view === 'roster' \? t\('members\.footCount'/)
  })

  it('the copy exists in both languages', () => {
    for (const k of ['members.unreadTitle', 'members.unreadLead', 'members.retry', 'members.footUnread']) {
      expect(en[k], k).toBeTruthy()
      expect(ptBR[k], k).toBeTruthy()
    }
  })
})
